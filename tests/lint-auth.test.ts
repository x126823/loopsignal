import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Production sign-in once failed for everyone: `trustHost: false` was set explicitly, and an explicit value overrides Auth.js's own rule
 * ("trust the host when AUTH_URL pins it"), so every production request ended in UntrustedHost. That cannot be reproduced without a
 * production server, so this guards the exact shape of the fix: production leaves trustHost unset, and the environment schema requires
 * AUTH_URL there (tested in src/lib/env.test.ts).
 */
describe("auth configuration", () => {
  const source = readFileSync("src/modules/identity/auth.ts", "utf8");

  it("never sets trustHost to false, or to an expression that is false in production", () => {
    expect(source).not.toMatch(/trustHost:\s*false/);
    expect(source).not.toMatch(/trustHost:\s*getEnv\(\)/);
    expect(source).not.toMatch(/trustHost:\s*[^{]*!==\s*["']production["']/);
  });

  it("trusts the request host only outside production, by leaving it to Auth.js (AUTH_URL) in production", () => {
    expect(source).toMatch(/\.\.\.\(getEnv\(\)\.NODE_ENV !== "production" \? \{ trustHost: true \} : \{\}\)/);
  });
});
