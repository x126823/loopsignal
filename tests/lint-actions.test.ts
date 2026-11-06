import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Server actions are reachable by a direct POST, and a layout or the proxy does not protect them (SECURITY.md: privilege escalation).
 * So every exported server action in the signed-in app must resolve the caller itself, with requireContext(), directly or through a local
 * helper that does. This fails the build if someone adds an action that forgets.
 */
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.tsx?$/.test(name) && /^\s*["']use server["']/.test(readFileSync(path, "utf8"))) yield path; // any file declaring server actions, whatever it is called
  }
}

describe("server actions in the signed-in app", () => {
  const appFiles = [...files("src/app/(app)")];

  it("finds the action files (so this test cannot pass by looking at nothing)", () => {
    expect(appFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const path of appFiles) {
    it(`${path}: every exported action authenticates its caller`, () => {
      const source = readFileSync(path, "utf8");
      expect(source.startsWith('"use server"'), "must be a server-actions file").toBe(true);
      // Local helpers that call requireContext() on the action's behalf.
      const helpers = [...source.matchAll(/^(?:async )?function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)^\}/gm)].filter((m) => /requireContext\(\)/.test(m[2]!)).map((m) => m[1]!);
      const actions = source.split(/^export async function /m).slice(1);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        const name = /^(\w+)/.exec(action)![1]!;
        // The body runs until the next top-level declaration.
        const body = action.split(/^(?:export )?(?:async )?function |^const |^\/\*\*/m)[0]!;
        const guarded = /requireContext\(\)/.test(body) || helpers.some((h) => new RegExp(`\\b${h}\\(`).test(body));
        expect(guarded, `${path}: ${name} does not call requireContext()`).toBe(true);
      }
    });
  }

  it("the sign-in actions, which run before anyone is signed in, are the only ones outside the guarded app", () => {
    const login = readFileSync("src/app/login/actions.ts", "utf8");
    expect(login).not.toMatch(/requireContext/);
    expect([...files("src/app")].filter((p) => !p.includes("(app)")).sort()).toEqual(["src/app/login/actions.ts"]);
  });
});
