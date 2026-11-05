/**
 * Confidence calibration. Given labeled outcomes (the analyzer's confidence and whether it was right), find the lowest
 * confidence threshold whose accepted answers meet a target precision. Answers below the threshold go to a human.
 * Thresholds are meaningful only for the provider and model that produced the samples: a threshold computed from the
 * heuristic fake says nothing about a real model.
 */
export interface Sample {
  confidence: number;
  correct: boolean;
}

export interface Calibration {
  threshold: number | null;
  /** Precision among samples at or above the threshold. */
  precision: number | null;
  /** How many samples are at or above the threshold. */
  support: number;
  /** Fraction of all samples that would be accepted without review. */
  coverage: number;
}

export function recommendThreshold(samples: readonly Sample[], opts: { targetPrecision?: number; minSupport?: number } = {}): Calibration {
  const target = opts.targetPrecision ?? 0.95;
  const minSupport = opts.minSupport ?? 5;
  const none: Calibration = { threshold: null, precision: null, support: 0, coverage: 0 };
  if (samples.length === 0) return none;

  const levels = [...new Set(samples.map((s) => s.confidence))].sort((a, b) => a - b);
  for (const t of levels) {
    const accepted = samples.filter((s) => s.confidence >= t);
    if (accepted.length < minSupport) break; // higher thresholds only have less support
    const precision = accepted.filter((s) => s.correct).length / accepted.length;
    if (precision >= target) return { threshold: t, precision, support: accepted.length, coverage: accepted.length / samples.length };
  }
  return none;
}
