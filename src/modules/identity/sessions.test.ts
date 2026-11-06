import { describe, expect, it } from "vitest";
import { sessionRevoked } from "./sessions";

const at = (s: string) => new Date(s);
const sec = (s: string) => Math.floor(new Date(s).getTime() / 1000);

describe("sessionRevoked", () => {
  it("never revokes anything for someone who has not ended their sessions", () => {
    expect(sessionRevoked(sec("2026-01-01T00:00:00Z"), null)).toBe(false);
    expect(sessionRevoked(undefined, null)).toBe(false);
  });

  it("voids a session issued before the revocation, and keeps one issued after it", () => {
    const revoked = at("2026-11-07T12:00:00.500Z");
    expect(sessionRevoked(sec("2026-11-07T11:59:59Z"), revoked)).toBe(true);
    expect(sessionRevoked(sec("2026-11-06T00:00:00Z"), revoked)).toBe(true);
    expect(sessionRevoked(sec("2026-11-07T12:00:02Z"), revoked)).toBe(false);
    expect(sessionRevoked(sec("2026-11-08T00:00:00Z"), revoked)).toBe(false);
  });

  it("never locks someone out of a session they started in the same second as the revocation", () => {
    const revoked = at("2026-11-07T12:00:00.500Z");
    expect(sessionRevoked(sec("2026-11-07T12:00:00Z"), revoked)).toBe(false); // signed in again immediately: the new session works
    expect(sessionRevoked(sec("2026-11-07T11:59:59Z"), at("2026-11-07T12:00:00.000Z"))).toBe(true); // a whole second earlier: void
  });

  it("treats a session whose issue time is unknown as void once anything was revoked", () => {
    expect(sessionRevoked(undefined, at("2026-11-07T12:00:00Z"))).toBe(true);
    expect(sessionRevoked(Number.NaN, at("2026-11-07T12:00:00Z"))).toBe(true);
  });
});
