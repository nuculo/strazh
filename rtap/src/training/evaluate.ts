import type { FittedModel } from './baselines/types.js';
import type { TrainingExample } from './dataset-exporter.js';

export interface EvaluationResult {
  readonly modelName: string;
  readonly n: number;
  readonly mse: number;
  readonly mae: number;
  /** Spearman rank correlation between predicted and actual label, in [-1, 1]. NaN if n < 2. */
  readonly rankCorrelation: number;
}

/**
 * FROZEN_INTEGRATION.md §11.1 admission gates: MSE/MAE for regression fit, rank
 * quality for what actually matters to a Planner (it acts on relative order, not
 * absolute utility values).
 */
export function evaluate(model: FittedModel, holdout: readonly TrainingExample[]): EvaluationResult {
  if (holdout.length === 0) {
    return { modelName: model.name, n: 0, mse: NaN, mae: NaN, rankCorrelation: NaN };
  }

  const predictions = holdout.map((e) => model.predict(e.features));
  const actuals = holdout.map((e) => e.label);

  let sqErrSum = 0;
  let absErrSum = 0;
  for (let i = 0; i < holdout.length; i += 1) {
    const err = predictions[i]! - actuals[i]!;
    sqErrSum += err * err;
    absErrSum += Math.abs(err);
  }

  return {
    modelName: model.name,
    n: holdout.length,
    mse: sqErrSum / holdout.length,
    mae: absErrSum / holdout.length,
    rankCorrelation: spearman(predictions, actuals),
  };
}

function rank(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[indexed[k]!.i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function spearman(a: readonly number[], b: readonly number[]): number {
  if (a.length < 2) return NaN;
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const meanA = ra.reduce((s, x) => s + x, 0) / n;
  const meanB = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = ra[i]! - meanA;
    const db = rb[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return NaN;
  return cov / Math.sqrt(varA * varB);
}
