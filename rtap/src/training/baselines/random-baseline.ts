import { hashBucket } from '../../features/encoders.js';
import type { Baseline, FittedModel } from './types.js';

/**
 * FROZEN_INTEGRATION.md §8.3 "random ranking". Deterministic-per-candidate, not
 * process-random: ADAPTIVE_REDTEAM_RUNTIME.md §16 admission criteria requires
 * "deterministic inference for the same bound input", and a baseline that violates
 * that on the first rung would make comparisons meaningless. Ignores `train`
 * entirely — that is the point of a random baseline.
 */
export const randomBaseline: Baseline = {
  name: 'random',
  fit(): FittedModel {
    return {
      name: 'random',
      predict: (features) => hashBucket(`${features.candidateProbeId ?? features.sourceObservationId ?? ''}:random-salt`),
    };
  },
};
