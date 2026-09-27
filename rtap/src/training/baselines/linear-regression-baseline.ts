import { MISSING } from '../../features/missing.js';
import type { TrainingExample } from '../dataset-exporter.js';
import type { Baseline, FittedModel } from './types.js';

/**
 * FROZEN_INTEGRATION.md §8.3 names "logistic regression" — the utility label is a
 * real-valued score, not a binary class, so plain linear regression (MSE loss) is
 * the correct member of that family here, not logistic. Documented substitution,
 * not a silent one. Fit by batch gradient descent, pure TS, no external ML
 * dependency — deterministic for a fixed `train` array (no shuffling, no random
 * init: weights start at 0), matching the same determinism requirement the random
 * baseline documents.
 */
export interface LinearRegressionOptions {
  readonly learningRate?: number;
  readonly epochs?: number;
  readonly l2?: number;
}

export interface FittedLinearModel extends FittedModel {
  readonly weights: readonly number[];
  readonly bias: number;
}

const DIM = 60;

function dot(weights: readonly number[], x: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += (weights[i] ?? 0) * (x[i] ?? 0);
  return sum;
}

/**
 * The inverse of `training/model-artifact.ts`'s `packageLinearModelArtifact()`:
 * that function wraps a fitted model's `weights`/`bias` in a `SerializedWeights`
 * envelope for signing; this reconstructs a working `FittedLinearModel` from that
 * same shape, for a caller (`planner/run-once.ts`) that has a promoted model's
 * weights on disk but no training data to re-fit from. `SignedModelArtifact` itself
 * carries only a `sha256` over the weights, not the weights — nothing in this repo
 * persists the weights durably yet, so a caller must supply them out of band; this
 * function only reconstructs the predictor once they're in hand.
 */
export function loadFittedLinearModel(weights: { readonly weights: readonly number[]; readonly bias: number }): FittedLinearModel {
  return {
    name: 'linear-regression',
    weights: weights.weights,
    bias: weights.bias,
    predict: (features) => dot(weights.weights, features.vector) + weights.bias,
  };
}

export function makeLinearRegressionBaseline(options: LinearRegressionOptions = {}): Baseline {
  const learningRate = options.learningRate ?? 0.02;
  const epochs = options.epochs ?? 400;
  const l2 = options.l2 ?? 0.001;

  return {
    name: 'linear-regression',
    fit(train: readonly TrainingExample[]): FittedLinearModel {
      const weights = new Array(DIM).fill(0);
      let bias = 0;

      if (train.length > 0) {
        for (let epoch = 0; epoch < epochs; epoch += 1) {
          const gradW = new Array(DIM).fill(0);
          let gradB = 0;
          for (const example of train) {
            const x = example.features.vector;
            const prediction = dot(weights, x) + bias;
            const error = prediction - example.label;
            for (let i = 0; i < DIM; i += 1) gradW[i] += error * (x[i] ?? MISSING);
            gradB += error;
          }
          for (let i = 0; i < DIM; i += 1) {
            weights[i] -= learningRate * (gradW[i] / train.length + l2 * weights[i]);
          }
          bias -= learningRate * (gradB / train.length);
        }
      }

      const finalWeights = [...weights];
      const finalBias = bias;
      return {
        name: 'linear-regression',
        weights: finalWeights,
        bias: finalBias,
        predict: (features) => dot(finalWeights, features.vector) + finalBias,
      };
    },
  };
}
