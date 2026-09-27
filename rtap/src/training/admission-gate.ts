import type { EvaluationResult } from './evaluate.js';
import { NOT_IMPLEMENTED_BASELINES } from './baselines/index.js';

export interface AdmissionGateResult {
  readonly candidateName: string;
  readonly beatsBestBaseline: boolean;
  readonly bestBaselineName: string;
  readonly bestBaselineRankCorrelation: number;
  readonly candidateRankCorrelation: number;
  readonly margin: number;
  readonly comparedAgainst: readonly string[];
  readonly notCompared: readonly string[];
}

/**
 * FROZEN_INTEGRATION.md §8.3: "Frozen must beat or justify itself against ... A
 * smaller artifact or lower traffic is not sufficient if decision quality degrades
 * beyond the accepted budget." This compares rank correlation (what a Planner
 * actually consumes — relative order, not absolute utility) between a candidate
 * model and the best of the *implemented* baselines, and is explicit in its result
 * about which baselines it could not compare against (§12 F2 readiness gap).
 */
export function evaluateAdmissionGate(
  candidate: EvaluationResult,
  baselines: readonly EvaluationResult[],
  options: { readonly requiredMargin?: number } = {},
): AdmissionGateResult {
  if (baselines.length === 0) {
    throw new Error('evaluateAdmissionGate requires at least one baseline result to compare against');
  }
  const requiredMargin = options.requiredMargin ?? 0;

  const best = baselines.reduce((a, b) => {
    const aScore = Number.isNaN(a.rankCorrelation) ? -Infinity : a.rankCorrelation;
    const bScore = Number.isNaN(b.rankCorrelation) ? -Infinity : b.rankCorrelation;
    return bScore > aScore ? b : a;
  });

  const candidateScore = Number.isNaN(candidate.rankCorrelation) ? -Infinity : candidate.rankCorrelation;
  const bestScore = Number.isNaN(best.rankCorrelation) ? -Infinity : best.rankCorrelation;
  const margin = candidateScore - bestScore;

  return {
    candidateName: candidate.modelName,
    beatsBestBaseline: margin > requiredMargin,
    bestBaselineName: best.modelName,
    bestBaselineRankCorrelation: best.rankCorrelation,
    candidateRankCorrelation: candidate.rankCorrelation,
    margin,
    comparedAgainst: baselines.map((b) => b.modelName),
    notCompared: NOT_IMPLEMENTED_BASELINES,
  };
}
