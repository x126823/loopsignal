import { ANALYZERS, type AnalyzerName } from "../analyzers";
import type { AnalyzerDefinition } from "../schemas";
import { recommendThreshold, type Calibration, type Sample } from "../calibration";
import { execute, prepare } from "../core";
import type { LLMProvider } from "../types";
import { ACK_CASES, SUBSTANTIVE_CASES } from "./data/reply";
import { INTENT_CASES } from "./data/intent";
import { OWNERSHIP_CASES } from "./data/ownership";
import { PROGRESS_CASES } from "./data/progress";
import { RESOLUTION_CASES } from "./data/resolution";
import { CORRELATION_CASES } from "./data/correlation";
import { RISK_CASES } from "./data/risk";
import type { GoldenCase } from "./types";

export const GOLDEN_SETS: Record<AnalyzerName, ReadonlyArray<GoldenCase<Record<string, unknown>>>> = {
  intent_classifier: INTENT_CASES,
  ownership_resolver: OWNERSHIP_CASES,
  acknowledgment_detector: ACK_CASES,
  substantive_response: SUBSTANTIVE_CASES,
  progress_analyzer: PROGRESS_CASES,
  resolution_analyzer: RESOLUTION_CASES,
  sla_risk_analyzer: RISK_CASES,
  correlation_analyzer: CORRELATION_CASES,
};

/** The one field of each analyzer's result that the golden label is about. */
const KEY: Record<AnalyzerName, string> = {
  intent_classifier: "actionable", ownership_resolver: "ownerUserId", acknowledgment_detector: "isAcknowledgment", substantive_response: "isSubstantive",
  progress_analyzer: "isProgress", resolution_analyzer: "signal", sla_risk_analyzer: "risk", correlation_analyzer: "sameMatter",
};

/** "Positive" means the analyzer found something: true, a named owner, or any resolution signal other than "none". */
const isPositive = (v: unknown) => v !== false && v !== null && v !== "none" && v !== "LOW" && v !== "no" && v !== "unsure"; // risk: only MEDIUM/HIGH are "at risk"; correlation: only "yes" is a match

export interface CaseRow {
  id: string;
  expected: unknown;
  /** null when the analyzer abstained (the guards rejected its output, so a human would review it). */
  predicted: unknown;
  abstainedBecause: string | null;
  confidence: number | null;
  correct: boolean;
}

export interface AnalyzerMetrics {
  promptVersion: string;
  total: number;
  answered: number;
  abstained: number;
  /** Correct among answered cases. */
  accuracy: number;
  /** Of the answers that said "positive" (actionable / owner named / ack / substantive), how many were right. */
  precision: number;
  /** Of the truly positive cases, how many were found automatically (abstentions count as missed). */
  recall: number;
  f1: number;
  /** Ownership only: assigned someone other than the named owner, or assigned when none was named. The costly error. */
  wrongAssignments?: number;
  calibration: Calibration;
  rows: CaseRow[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

async function runSet(name: AnalyzerName, provider: LLMProvider, secret: Buffer, threshold: number): Promise<AnalyzerMetrics> {
  const def = ANALYZERS[name] as AnalyzerDefinition<unknown>;
  const cases = GOLDEN_SETS[name];
  const rows: CaseRow[] = [];
  let tp = 0, fp = 0, fn = 0, wrongAssignments = 0;

  for (const gc of cases) {
    const prepared = prepare(def, gc.messages, gc.candidates ?? [], provider, secret, gc.facts ?? {});
    const run = await execute(def, prepared, provider, threshold);
    const expected = gc.expected[KEY[name]];
    if (run.kind === "failed") {
      rows.push({ id: gc.id, expected, predicted: null, abstainedBecause: run.reason, confidence: null, correct: false });
      // An abstained positive was not found automatically (a human would have to), so it counts as missed for recall.
      if (isPositive(expected)) fn++;
      continue;
    }
    const predicted = (run.output.result as Record<string, unknown>)[KEY[name]];
    // For ownership an unknown candidate id is treated like a wrong answer, never silently accepted.
    const valid = name !== "ownership_resolver" || predicted === null || (gc.candidates ?? []).some((c) => c.id === predicted);
    const correct = valid && predicted === expected;
    rows.push({ id: gc.id, expected, predicted: valid ? predicted : "INVALID_CANDIDATE", abstainedBecause: null, confidence: run.output.confidence, correct });

    const positiveExpected = isPositive(expected);
    const positivePredicted = isPositive(predicted);
    if (positivePredicted && correct) tp++;
    else if (positivePredicted) fp++;
    if (positiveExpected && !correct) fn++;
    if (name === "ownership_resolver" && positivePredicted && !correct) wrongAssignments++;
  }

  const answered = rows.filter((r) => r.abstainedBecause === null);
  const correct = answered.filter((r) => r.correct).length;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const samples: Sample[] = answered.map((r) => ({ confidence: r.confidence!, correct: r.correct }));
  return {
    promptVersion: def.promptVersion,
    total: rows.length,
    answered: answered.length,
    abstained: rows.length - answered.length,
    accuracy: round(ratio(correct, answered.length)),
    precision: round(precision),
    recall: round(recall),
    f1: round(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)),
    ...(name === "ownership_resolver" ? { wrongAssignments } : {}),
    calibration: recommendThreshold(samples, { targetPrecision: 0.95, minSupport: 5 }),
    rows,
  };
}

export type GoldenReport = Record<AnalyzerName, AnalyzerMetrics>;

/** Run every golden set through the real guards (prepare + execute) with the given provider. No database needed. */
export async function runGolden(provider: LLMProvider, opts: { secret?: Buffer; confidenceThreshold?: number } = {}): Promise<GoldenReport> {
  const secret = opts.secret ?? Buffer.alloc(32, 9);
  const threshold = opts.confidenceThreshold ?? 0.8;
  const out = {} as GoldenReport;
  for (const name of Object.keys(GOLDEN_SETS) as AnalyzerName[]) out[name] = await runSet(name, provider, secret, threshold);
  return out;
}

export interface Baseline {
  provider: string;
  model: string;
  /** True for providers whose scores say nothing about a real model (the heuristic fake). */
  notForProduction: boolean;
  analyzers: Record<string, Omit<AnalyzerMetrics, "rows">>;
}

export function toBaseline(provider: Pick<LLMProvider, "name" | "model">, report: GoldenReport, notForProduction: boolean): Baseline {
  return {
    provider: provider.name, model: provider.model, notForProduction,
    analyzers: Object.fromEntries(Object.entries(report).map(([k, m]) => {
      const summary: Partial<AnalyzerMetrics> = { ...m };
      delete summary.rows; // per-case rows stay out of the recorded baseline
      return [k, summary];
    })) as Baseline["analyzers"],
  };
}
