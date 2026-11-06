import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * OAuth credentials live in one table that only src/modules/sources may touch (CLAUDE.md: no cross-module table access, and rule
 * 10). A query anywhere else could expose or mis-handle tokens, so this fails the build if one appears.
 */
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|tsx)$/.test(name)) yield path;
  }
}

describe("credential table access", () => {
  const offenders = (pattern: RegExp, allowed: (rel: string) => boolean) =>
    [...files("src")].map((p) => relative(".", p)).filter((rel) => !allowed(rel) && pattern.test(readFileSync(rel, "utf8")));

  it("is queried only inside the sources module", () => {
    expect(offenders(/\.connectionCredential\b/, (rel) => rel.startsWith("src/modules/sources/"))).toEqual([]);
  });

  it("the stored token column is read only by the credential store", () => {
    expect(offenders(/ConnectionCredential\.tokens/, (rel) => rel === "src/modules/sources/credentials.ts")).toEqual([]);
  });
});
