import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A misconfigured production deployment must FAIL TO START. Settings are otherwise validated only when something first reads them, so
 * without this hook the web server starts and answers every request with a 500. Next.js logs an error thrown during startup and keeps
 * serving, so the hook has to exit explicitly. The real behaviour is exercised by `npm run rehearse:production`; this guards its shape.
 */
describe("boot-time environment validation", () => {
  it("is registered, runs only on the Node runtime, and validates through the environment schema", () => {
    expect(existsSync("src/instrumentation.ts")).toBe(true);
    const hook = readFileSync("src/instrumentation.ts", "utf8");
    expect(hook).toMatch(/export async function register/);
    expect(hook).toMatch(/NEXT_RUNTIME"\] === "nodejs"/);
    expect(hook).toMatch(/validateEnvironmentOrExit\(\)/);
  });

  it("exits the process on an invalid environment, and prints only the schema's message (key names, never values)", () => {
    const node = readFileSync("src/instrumentation-node.ts", "utf8");
    expect(node).toMatch(/getEnv\(\)/);
    expect(node).toMatch(/process\.exit\(1\)/);
    expect(node).toMatch(/e instanceof Error \? e\.message/);
    expect(node).not.toMatch(/process\.env/); // it never prints the environment
  });
});
