import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
async function violations(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-syntax");
}

describe("rule 1 lint guard: only src/modules/lifecycle writes TrackedItem", () => {
  const writes = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

  for (const op of writes) {
    it(`bans trackedItem.${op} outside the lifecycle module`, async () => {
      const code = `declare const tx: { trackedItem: Record<string, (a: unknown) => unknown> };\ntx.trackedItem.${op}({});\n`;
      expect(await violations(code, "src/modules/sla/bad.ts")).toHaveLength(1);
      expect(await violations(`declare const db: { tx: { trackedItem: Record<string, (a: unknown) => unknown> } };\ndb.tx.trackedItem.${op}({});\n`, "src/app/bad.ts")).toHaveLength(1);
    });
  }

  it("allows reads anywhere, and writes inside the lifecycle module", async () => {
    const read = `declare const tx: { trackedItem: Record<string, (a: unknown) => unknown> };\ntx.trackedItem.findMany({});\n`;
    expect(await violations(read, "src/modules/sla/ok.ts")).toHaveLength(0);
    const write = `declare const tx: { trackedItem: Record<string, (a: unknown) => unknown> };\ntx.trackedItem.update({});\n`;
    expect(await violations(write, "src/modules/lifecycle/engine-extra.ts")).toHaveLength(0);
  });

  it("also covers the seed, which must go through the engine", async () => {
    const code = `declare const tx: { trackedItem: Record<string, (a: unknown) => unknown> };\ntx.trackedItem.create({});\n`;
    expect(await violations(code, "prisma/seed-extra.ts")).toHaveLength(1);
  });

  it("bans the guard flag name outside the lifecycle module", async () => {
    expect(await violations(`export const a = "lifecycle_writer";\n`, "src/modules/sla/flag.ts")).toHaveLength(1);
    expect(await violations("export const b = `select set_config('app.lifecycle_writer', 'on', true)`;\n", "src/lib/flag.ts")).toHaveLength(1);
    expect(await violations(`export const a = "lifecycle_writer";\n`, "src/modules/lifecycle/ok.ts")).toHaveLength(0);
  });
}, 60_000);
