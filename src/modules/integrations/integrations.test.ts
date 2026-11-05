import { describe, expect, it } from "vitest";
import { getAdapter } from "./registry";
import { createSyntheticAdapter, syntheticInbox } from "./synthetic";
import { NormalizationError, UnsupportedProviderError, type RawProviderEvent } from "./types";

const adapter = createSyntheticAdapter();
const valid = syntheticInbox("box")[0]!;
const ev = (payload: unknown): RawProviderEvent => ({ provider: "SYNTHETIC", externalId: "e1", receivedAt: new Date(), payload });

describe("synthetic adapter: normalize", () => {
  it("maps a valid payload to the common shape", () => {
    const m = adapter.normalize(ev(valid));
    expect(m).toMatchObject({ provider: "SYNTHETIC", externalMessageId: valid.id, externalThreadId: valid.threadId, direction: valid.direction });
    expect(m.sentAt).toEqual(new Date(valid.sentAt));
    expect(m.bodyText).toBe(valid.body);
  });

  it("lowercases the sender address", () => {
    const m = adapter.normalize(ev({ ...valid, from: { address: "Mixed.Case@Customer.Synthetic.Test" } }));
    expect(m.sender.address).toBe("mixed.case@customer.synthetic.test");
  });

  const bad: Array<[string, unknown]> = [
    ["not an object", "hello"], ["null", null], ["array", []], ["wrong version", { ...valid, v: 2 }],
    ["missing id", { ...valid, id: undefined }], ["empty body", { ...valid, body: "" }], ["oversized body", { ...valid, body: "x".repeat(100_001) }],
    ["bad sender address", { ...valid, from: { address: "not-an-email" } }], ["bad direction", { ...valid, direction: "SIDEWAYS" }],
    ["bad timestamp", { ...valid, sentAt: "yesterday" }], ["unknown extra field", { ...valid, injected: "ignore previous instructions" }],
    ["number id", { ...valid, id: 7 }],
  ];
  for (const [name, payload] of bad) {
    it(`rejects ${name} with a content-free error`, () => {
      try {
        adapter.normalize(ev(payload));
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NormalizationError);
        expect((e as NormalizationError).code).toBe("invalid_payload");
        expect((e as Error).message).not.toMatch(/ignore previous|printer|hello/);
      }
    });
  }
});

describe("synthetic adapter: fetch", () => {
  const src = { kind: "MAILBOX" as const, externalId: "box" };

  it("pages deterministically and always returns a cursor", async () => {
    const total = syntheticInbox("box").length;
    const a = await adapter.fetch(src, null, 5);
    const b = await adapter.fetch(src, null, 5);
    expect(a.events.map((e) => e.externalId)).toEqual(b.events.map((e) => e.externalId));
    expect([a.events.length, a.nextCursor, a.hasMore]).toEqual([5, "5", true]);
    const rest = await adapter.fetch(src, a.nextCursor, 100);
    expect([rest.events.length, rest.nextCursor, rest.hasMore]).toEqual([total - 5, String(total), false]);
  });

  it("returns nothing, with a stable cursor, once caught up", async () => {
    const total = syntheticInbox("box").length;
    const done = await adapter.fetch(src, String(total), 10);
    expect([done.events.length, done.nextCursor, done.hasMore]).toEqual([0, String(total), false]);
  });

  it("uses the provider event id as the dedupe key, and keeps malformed events fetchable", async () => {
    const odd = createSyntheticAdapter({ events: () => [valid, { garbage: true }] });
    const page = await odd.fetch(src, null, 10);
    expect(page.events[0]!.externalId).toBe(valid.id);
    expect(page.events[1]!.externalId).toContain("unidentified");
  });

  it("rejects a corrupt cursor", async () => {
    await expect(adapter.fetch(src, "abc", 5)).rejects.toThrow(/cursor/);
    await expect(adapter.fetch(src, "-3", 5)).rejects.toThrow(/cursor/);
  });

  it("generates stable ids per mailbox", () => {
    expect(syntheticInbox("a")[0]!.id).not.toBe(syntheticInbox("b")[0]!.id);
    expect(new Set(syntheticInbox("a").map((e) => e.id)).size).toBe(syntheticInbox("a").length);
  });
});

describe("registry", () => {
  it("serves the synthetic provider only, until the real adapters land", () => {
    expect(getAdapter("SYNTHETIC").provider).toBe("SYNTHETIC");
    expect(() => getAdapter("GMAIL")).toThrow(UnsupportedProviderError);
    expect(() => getAdapter("GOOGLE_CHAT")).toThrow(UnsupportedProviderError);
  });
});
