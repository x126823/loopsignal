import { describe, expect, it } from "vitest";
import { anchorIsAuthentic, makeAnchor, parseAnchorLine } from "./anchor";

const KEY = "k".repeat(40);
const ORG = "0b1f6c1e-7f0e-4e0b-9c63-3a4f5e6d7a8b";
const HASH = "a".repeat(64);
const anchor = () => makeAnchor(KEY, ORG, { seq: 42n, hash: HASH }, new Date("2026-11-07T10:00:00Z"));

describe("anchors", () => {
  it("are deterministic, and carry the sequence as text so large numbers survive", () => {
    expect(anchor()).toEqual(anchor());
    expect(anchor()).toMatchObject({ organizationId: ORG, seq: "42", hash: HASH, at: "2026-11-07T10:00:00.000Z" });
    expect(makeAnchor(KEY, ORG, { seq: 9_007_199_254_740_993n, hash: HASH }, new Date(0)).seq).toBe("9007199254740993");
  });

  it("verify with the key they were signed with, and with no other", () => {
    expect(anchorIsAuthentic(KEY, anchor())).toBe(true);
    expect(anchorIsAuthentic("j".repeat(40), anchor())).toBe(false);
  });

  it("cannot be edited: changing any field breaks the signature", () => {
    const a = anchor();
    for (const edit of [{ organizationId: "1b1f6c1e-7f0e-4e0b-9c63-3a4f5e6d7a8b" }, { seq: "41" }, { seq: "43" }, { hash: "b".repeat(64) }, { at: "2026-11-07T10:00:01.000Z" }]) {
      expect(anchorIsAuthentic(KEY, { ...a, ...edit }), JSON.stringify(edit)).toBe(false);
    }
    expect(anchorIsAuthentic(KEY, { ...a, mac: "0".repeat(64) })).toBe(false);
    expect(anchorIsAuthentic(KEY, { ...a, mac: "not hex" })).toBe(false);
    expect(anchorIsAuthentic(KEY, { ...a, mac: "" })).toBe(false);
  });

  it("do not let one field slide into another (fields are delimited)", () => {
    const a = makeAnchor(KEY, ORG, { seq: 1n, hash: HASH }, new Date("2026-11-07T10:00:00Z"));
    expect(anchorIsAuthentic(KEY, { ...a, seq: "1|" + HASH.slice(0, 10), hash: HASH.slice(10) + "0".repeat(10) })).toBe(false);
  });

  it("are read back from a line only when well formed", () => {
    expect(parseAnchorLine(JSON.stringify(anchor()))).toEqual(anchor());
    for (const bad of ["", "not json", "{}", JSON.stringify({ ...anchor(), seq: "-1" }), JSON.stringify({ ...anchor(), seq: 4 }), JSON.stringify({ ...anchor(), hash: "short" }), JSON.stringify({ ...anchor(), organizationId: "x" }), JSON.stringify({ ...anchor(), at: "yesterday" }), JSON.stringify([anchor()])]) {
      expect(parseAnchorLine(bad), bad).toBeNull();
    }
  });
});
