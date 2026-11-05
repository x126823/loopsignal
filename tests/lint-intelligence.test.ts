import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
async function restricted(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

describe("analyzers only recommend: the intelligence module cannot import lifecycle mutators", () => {
  for (const name of ["apply", "propose", "createItem", "decideApproval", "assignOwner"]) {
    it(`bans importing ${name} inside src/modules/intelligence`, async () => {
      const hits = await restricted(`import { ${name} } from "@/modules/lifecycle";\nexport const x = ${name};\n`, "src/modules/intelligence/bad.ts");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.message).toMatch(/only recommend/);
    });
  }

  it("still allows read-only lifecycle exports, and mutators elsewhere", async () => {
    expect(await restricted(`import { HUMAN_DECISION_STATES, DEFAULT_CONFIDENCE_THRESHOLD } from "@/modules/lifecycle";\nexport const x = [HUMAN_DECISION_STATES, DEFAULT_CONFIDENCE_THRESHOLD];\n`, "src/modules/intelligence/ok.ts")).toHaveLength(0);
    expect(await restricted(`import { propose } from "@/modules/lifecycle";\nexport const x = propose;\n`, "src/workers/ok.ts")).toHaveLength(0);
  });
}, 60_000);
