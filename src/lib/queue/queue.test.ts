import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redisConnection } from "./connection";
import { analyzeMessageJob, deadLetterRecord, ingestSourceJob, jobIds } from "./jobs";

describe("redisConnection", () => {
  it("parses host, port, credentials and database", () => {
    expect(redisConnection("redis://user:p%40ss@cache.internal:6380/2")).toMatchObject({
      host: "cache.internal", port: 6380, username: "user", password: "p@ss", db: 2, maxRetriesPerRequest: null,
    });
  });
  it("defaults the port and database, and enables TLS for rediss", () => {
    expect(redisConnection("redis://localhost")).toMatchObject({ host: "localhost", port: 6379, db: 0 });
    expect(redisConnection("rediss://localhost")).toHaveProperty("tls");
  });
  it("rejects other protocols and bad database numbers", () => {
    expect(() => redisConnection("http://localhost")).toThrow(/redis:/);
    expect(() => redisConnection("redis://localhost/abc")).toThrow(/database/);
  });
});

describe("job payloads carry ids only", () => {
  const org = randomUUID();
  it("accepts ids", () => {
    expect(ingestSourceJob.parse({ organizationId: org, monitoredSourceId: randomUUID() })).toBeTruthy();
    expect(analyzeMessageJob.parse({ organizationId: org, messageId: randomUUID() })).toBeTruthy();
  });
  it("rejects any extra field, so content cannot ride along", () => {
    expect(() => analyzeMessageJob.parse({ organizationId: org, messageId: randomUUID(), body: "hello" })).toThrow();
    expect(() => ingestSourceJob.parse({ organizationId: org, monitoredSourceId: randomUUID(), cursor: "x" })).toThrow();
  });
  it("rejects non-uuid ids", () => {
    expect(() => analyzeMessageJob.parse({ organizationId: "x", messageId: randomUUID() })).toThrow();
  });
  it("builds deterministic job ids without colons (BullMQ forbids them)", () => {
    const j = { organizationId: org, messageId: randomUUID() };
    expect(jobIds.analyzeMessage(j)).toBe(jobIds.analyzeMessage(j));
    expect(jobIds.analyzeMessage(j)).not.toContain(":");
    expect(jobIds.ingestSource({ organizationId: org, monitoredSourceId: randomUUID() }, "c-abc")).not.toContain(":");
  });
  it("validates dead-letter records", () => {
    expect(deadLetterRecord.safeParse({ queue: "q", jobId: "1", data: {}, errorName: "Error", errorCode: null, attemptsMade: 5, failedAt: new Date().toISOString() }).success).toBe(true);
    expect(deadLetterRecord.safeParse({ queue: "q" }).success).toBe(false);
  });
});
