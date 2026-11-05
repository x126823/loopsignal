import { describe, expect, it } from "vitest";
import { canonicalJson } from "./ingest";

describe("canonicalJson", () => {
  it("does not depend on key order, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });
  it("distinguishes different values and preserves array order", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("handles primitives and undefined", () => {
    expect([canonicalJson(null), canonicalJson("x"), canonicalJson(3), canonicalJson(undefined)]).toEqual(["null", '"x"', "3", "null"]);
  });
});
