import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALERTS, buildAlertBody, cleanFields, flushAlerts, raiseAlert, resetAlertState, type AlertEvent } from "./alerts";

const URL_OK = "https://alerts.example.test/hook";
const fast = { sleep: async () => undefined };
const ok = () => new Response("{}", { status: 200 });

beforeEach(() => {
  resetAlertState();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("what an alert may carry", () => {
  it("keeps id-shaped strings, numbers, booleans and null, and drops everything else without ever repeating it", () => {
    const { fields, dropped } = cleanFields({
      organizationId: "0b1f6c1e-7f0e-4e0b-9c63-3a4f5e6d7a8b", firstBadSeq: 12, complete: false, nothing: null, errorName: "ProviderApiError", queue: "ingest-source",
      sentence: "Pat said the checkout is down", email: "pat@example.com", long: "a".repeat(81), object: { a: 1 } as never, "bad key!": "x", skipped: undefined, nan: Number.NaN,
    });
    expect(fields).toEqual({ organizationId: "0b1f6c1e-7f0e-4e0b-9c63-3a4f5e6d7a8b", firstBadSeq: 12, complete: false, nothing: null, errorName: "ProviderApiError", queue: "ingest-source" });
    expect(dropped).toBe(6);
  });

  it("builds a body from a fixed summary and severity, so there is no free text to leak", () => {
    const { body } = buildAlertBody("audit.chain_broken", { organizationId: "org-1", firstBadSeq: 7, secretish: "Bearer abc def" }, new Date("2026-11-07T10:00:00Z"));
    expect(JSON.parse(body)).toEqual({
      source: "loopsignal", event: "audit.chain_broken", severity: "critical", summary: "An organization's audit log failed its integrity check",
      at: "2026-11-07T10:00:00.000Z", details: { organizationId: "org-1", firstBadSeq: 7 }, droppedFields: 1,
    });
    expect(body).not.toContain("Bearer");
  });

  it("has a closed vocabulary: every event has a plain summary, a known severity, and a dedupe rule", () => {
    for (const [name, def] of Object.entries(ALERTS)) {
      expect(["critical", "error", "warning"], name).toContain(def.severity);
      expect(def.summary.length, name).toBeGreaterThan(20);
      expect(def.summary, name).not.toMatch(/[{}$]/);
      expect(Array.isArray(def.dedupeOn), name).toBe(true);
    }
    expect(Object.keys(ALERTS)).toEqual(expect.arrayContaining(["audit.chain_broken", "audit.verify_failed", "connection.needs_attention", "gmail.watch_renewal_failed", "chat.app_credentials_rejected", "retention.failed", "worker.error", "job.dead_lettered"]));
  });
});

describe("sending", () => {
  it("does nothing but log when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => ok());
    expect(await raiseAlert("audit.chain_broken", { organizationId: "o" }, { fetchImpl, config: {} })).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the JSON to the webhook, never following redirects, and signs it when a secret is set", async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok());
    const result = await raiseAlert("job.dead_lettered", { queue: "ingest-source", errorName: "ProviderApiError" }, { fetchImpl: fetchImpl as never, config: { url: URL_OK, secret: "s".repeat(20) }, now: () => 1_000 });
    expect(result).toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL_OK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const body = init.body as string;
    expect(JSON.parse(body)).toMatchObject({ event: "job.dead_lettered", severity: "warning", details: { queue: "ingest-source", errorName: "ProviderApiError" } });
    expect((init.headers as Record<string, string>)["x-loopsignal-signature"]).toBe(`sha256=${createHmac("sha256", "s".repeat(20)).update(body).digest("hex")}`);
  });

  it("sends no signature header when there is no secret", async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok());
    await raiseAlert("worker.error", { queue: "q", errorName: "Error" }, { fetchImpl: fetchImpl as never, config: { url: URL_OK } });
    expect((fetchImpl.mock.calls[0]![1].headers as Record<string, string>)["x-loopsignal-signature"]).toBeUndefined();
  });

  it("alerts once per window for a recurring problem, and again after the window", async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => ok());
    const send = () => raiseAlert("retention.failed", { organizationId: "org-a", errorName: "Timeout" }, { fetchImpl: fetchImpl as never, config: { url: URL_OK, dedupeMinutes: 60 }, now: () => t });
    expect(await send()).toBe("sent");
    expect(await send()).toBe("suppressed");
    t += 59 * 60_000;
    expect(await send()).toBe("suppressed");
    t += 2 * 60_000;
    expect(await send()).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats different organizations, connections and events as different problems", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const cfg = { fetchImpl: fetchImpl as never, config: { url: URL_OK } };
    expect(await raiseAlert("connection.needs_attention", { organizationId: "a", connectionId: "c1" }, cfg)).toBe("sent");
    expect(await raiseAlert("connection.needs_attention", { organizationId: "a", connectionId: "c2" }, cfg)).toBe("sent");
    expect(await raiseAlert("connection.needs_attention", { organizationId: "b", connectionId: "c1" }, cfg)).toBe("sent");
    expect(await raiseAlert("retention.failed", { organizationId: "a" }, cfg)).toBe("sent");
    expect(await raiseAlert("connection.needs_attention", { organizationId: "a", connectionId: "c1" }, cfg)).toBe("suppressed");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("sends one alert, not several, when the same problem is raised at the same moment", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => { await gate; return ok(); });
    const cfg = { fetchImpl: fetchImpl as never, config: { url: URL_OK } };
    const all = Promise.all([1, 2, 3].map(() => raiseAlert("chat.app_credentials_rejected", { code: "invalid_grant" }, cfg)));
    await Promise.resolve();
    release();
    expect((await all).sort()).toEqual(["sent", "suppressed", "suppressed"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once, reports failure without throwing, and tries again on the next occurrence rather than staying quiet", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 503 }));
    const cfg = { fetchImpl: fetchImpl as never, config: { url: URL_OK }, ...fast };
    expect(await raiseAlert("worker.error", { queue: "q", errorName: "Error" }, cfg)).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mockImplementation(async () => ok());
    expect(await raiseAlert("worker.error", { queue: "q", errorName: "Error" }, cfg)).toBe("sent");
  });

  it("succeeds on the retry when the first attempt fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED")).mockResolvedValueOnce(ok());
    expect(await raiseAlert("worker.error", { queue: "retry", errorName: "Error" }, { fetchImpl: fetchImpl as never, config: { url: URL_OK }, ...fast })).toBe("sent");
  });

  it("never throws, whatever goes wrong while sending", async () => {
    const throwing = (() => { throw new Error("synchronous failure"); }) as unknown as typeof fetch;
    await expect(raiseAlert("worker.error", { queue: "boom", errorName: "Error" }, { fetchImpl: throwing, config: { url: URL_OK }, ...fast })).resolves.toBe("failed");
    const redirected = vi.fn(async () => { throw new TypeError("redirect mode is set to error"); });
    await expect(raiseAlert("worker.error", { queue: "redir", errorName: "Error" }, { fetchImpl: redirected as never, config: { url: URL_OK }, ...fast })).resolves.toBe("failed");
    await flushAlerts();
  });

  it("never throws even when the failure is in its own preparation, before anything is sent", async () => {
    const brokenClock = () => { throw new Error("the clock failed"); };
    await expect(raiseAlert("worker.error", { queue: "clock", errorName: "Error" }, { config: { url: URL_OK }, now: brokenClock, fetchImpl: vi.fn() as never })).resolves.toBe("failed");
    await expect(raiseAlert("worker.error", { queue: "clock2", errorName: "Error" }, { config: {}, now: brokenClock })).resolves.toBe("failed");
  });

  it("logs the alert even when nothing is sent, with ids only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    await raiseAlert("audit.chain_broken", { organizationId: "org-9", firstBadSeq: 3, note: "free text here" }, { config: {} });
    const line = lines.find((l) => l.includes("alert.raised"))!;
    expect(JSON.parse(line)).toMatchObject({ level: "error", event: "alert.raised", alert: "audit.chain_broken", organizationId: "org-9" });
    expect(line).not.toContain("free text");
  });

  it("every event can be raised without error", async () => {
    const fetchImpl = vi.fn(async () => ok());
    for (const event of Object.keys(ALERTS) as AlertEvent[]) expect(await raiseAlert(event, {}, { fetchImpl: fetchImpl as never, config: { url: URL_OK } }), event).toBe("sent");
  });
});
