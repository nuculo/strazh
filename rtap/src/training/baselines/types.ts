import type { CandidateFeatureSnapshot } from '../../features/candidate-compiler.js';
import type { TrainingExample } from '../dataset-exporter.js';

export interface FittedModel {
  readonly name: string;
  /** Deterministic: the same features always produce the same prediction. */
  predict(features: CandidateFeatureSnapshot): number;
}

export interface Baseline {
  readonly name: string;
  fit(train: readonly TrainingExample[]): FittedModel;
}
