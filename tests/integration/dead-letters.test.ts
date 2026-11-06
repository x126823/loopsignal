import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deadLetterName, listDeadLetters, QUEUES, retryDeadLetter, type QueueHub } from "@/lib/queue";
import { createTestHub, destroyTestHub, waitingJobs } from "../helpers/queue";

let hub: QueueHub;
beforeAll(() => { hub = createTestHub(); });
afterAll(async () => { await destroyTestHub(hub); });

const dead = (queue: string, jobId: string, data: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  hub.queue(deadLetterName(queue as never)).add("dead", { queue, jobId, data, errorName: "ProviderApiError", errorCode: null, attemptsMade: 5, failedAt: new Date().toISOString(), ...over }, { jobId: `dead-${jobId}`, removeOnComplete: false });

describe("dead letters", () => {
  const org = randomUUID();
  const source = randomUUID();

  it("are listed with ids and the error class only, oldest first, across queues", async () => {
    await dead(QUEUES.ingestSource, "j-old", { organizationId: org, monitoredSourceId: source }, { failedAt: "2026-11-01T00:00:00.000Z" });
    await dead(QUEUES.analyzeMessage, "j-new", { organizationId: org, messageId: randomUUID() }, { failedAt: "2026-11-02T00:00:00.000Z", errorName: "ProviderRateLimitError" });
    const rows = await listDeadLetters(hub);
    expect(rows.map((r) => r.jobId)).toEqual(["j-old", "j-new"]);
    expect(rows[0]).toMatchObject({ queue: "ingest-source", errorName: "ProviderApiError", attemptsMade: 5, deadId: "dead-j-old" });
    expect(JSON.stringify(rows)).not.toMatch(/stack|message":"/);
    expect((await listDeadLetters(hub, QUEUES.analyzeMessage)).map((r) => r.jobId)).toEqual(["j-new"]);
  });

  it("skips anything that is not a dead-letter record, rather than guessing", async () => {
    await hub.queue(deadLetterName(QUEUES.slaScan)).add("dead", { nonsense: true }, { jobId: "dead-nonsense" });
    expect((await listDeadLetters(hub, QUEUES.slaScan))).toEqual([]);
  });

  it("are retried by putting the original job back on its queue under a new id, and the dead letter is removed", async () => {
    const out = await retryDeadLetter(hub, QUEUES.ingestSource, "dead-j-old");
    expect(out).toBe("REQUEUED");
    const queued = (await waitingJobs(hub, QUEUES.ingestSource)).filter((j) => j.data.monitoredSourceId === source);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toMatch(/^retry-dead-j-old-/);
    expect(queued[0]!.data).toEqual({ organizationId: org, monitoredSourceId: source }); // ids only, as validated
    expect((await listDeadLetters(hub, QUEUES.ingestSource)).map((r) => r.jobId)).not.toContain("j-old");
    expect(await retryDeadLetter(hub, QUEUES.ingestSource, "dead-j-old")).toBe("NOT_FOUND"); // not twice
  });

  it("refuse to re-queue a payload that is no longer valid for the queue, and leave it in place", async () => {
    await dead(QUEUES.analyzeMessage, "j-bad", { organizationId: "not-a-uuid", messageId: "x", body: "smuggled" });
    expect(await retryDeadLetter(hub, QUEUES.analyzeMessage, "dead-j-bad")).toBe("INVALID");
    expect((await listDeadLetters(hub, QUEUES.analyzeMessage)).map((r) => r.jobId)).toContain("j-bad");
    expect((await waitingJobs(hub, QUEUES.analyzeMessage)).some((j) => JSON.stringify(j.data).includes("smuggled"))).toBe(false);
    expect(await retryDeadLetter(hub, QUEUES.analyzeMessage, "dead-never-existed")).toBe("NOT_FOUND");
  });
});
