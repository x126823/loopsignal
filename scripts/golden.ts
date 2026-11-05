// Run the golden sets and print metrics. Usage:
//   npm run golden                       heuristic fake (free, deterministic)
//   npm run golden -- --write            also record golden baseline for the fake
//   LIVE_LLM=1 npm run golden -- --provider claude [--write]   REAL model: costs money, synthetic data only
import { writeFileSync } from "node:fs";
import { ClaudeProvider, HeuristicProvider, runGolden, toBaseline, GOLDEN_SETS, type LLMProvider } from "../src/modules/intelligence";

const args = process.argv.slice(2);
const providerName = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : "fake";
const write = args.includes("--write");

async function main(): Promise<void> {
  let provider: LLMProvider;
  if (providerName === "claude") {
    if (process.env["LIVE_LLM"] !== "1") {
      console.error("Refusing to call a real model without LIVE_LLM=1 (this spends money). Golden cases are synthetic text only.");
      process.exit(2);
    }
    const cases = Object.values(GOLDEN_SETS).reduce((n, s) => n + s.length, 0);
    console.log(`About to run ${cases} golden cases against the real model (each can retry once). Starting.`);
    provider = new ClaudeProvider({ model: process.env["LLM_MODEL"] ?? "claude-opus-5-5", effort: (process.env["LLM_EFFORT"] as "low" | "medium" | "high" | undefined) ?? "medium" });
  } else {
    provider = new HeuristicProvider();
  }

  const report = await runGolden(provider);
  for (const [name, m] of Object.entries(report)) {
    const c = m.calibration;
    console.log(
      `${name.padEnd(24)} v${m.promptVersion} n=${m.total} answered=${m.answered} acc=${m.accuracy} P=${m.precision} R=${m.recall} F1=${m.f1}` +
        `${m.wrongAssignments !== undefined ? ` wrongAssign=${m.wrongAssignments}` : ""}  threshold@95%P=${c.threshold ?? "none"} (coverage ${Math.round(c.coverage * 100)}%)`,
    );
    for (const r of m.rows.filter((x) => !x.correct)) console.log(`    miss: ${r.id} expected=${JSON.stringify(r.expected)} got=${JSON.stringify(r.predicted)}${r.abstainedBecause ? ` (abstained: ${r.abstainedBecause})` : ""}`);
  }
  if (write) {
    const file = `src/modules/intelligence/golden/baselines/${provider.name}-${provider.model}.json`;
    writeFileSync(file, `${JSON.stringify(toBaseline(provider, report, provider.name !== "claude"), null, 2)}\n`);
    console.log(`Wrote ${file}`);
  }
}
void main();
