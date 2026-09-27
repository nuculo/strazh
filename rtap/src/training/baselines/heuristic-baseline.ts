import { COORD } from '../../features/coordinates.js';
import { MISSING } from '../../features/missing.js';
import type { Baseline, FittedModel } from './types.js';

/**
 * FROZEN_INTEGRATION.md §8.3 "hand-written heuristic baseline". Fixed weights,
 * chosen by hand, not fit from data — that is what makes it a fair baseline for the
 * learned models to beat. Prioritizes probes this campaign has attempted least, that
 * are not already confirmed vulnerable, and whose vulnerability class hasn't been
 * explored yet — a defensible "spend budget on the unknown" policy.
 */
export const heuristicBaseline: Baseline = {
  name: 'heuristic',
  fit(): FittedModel {
    return {
      name: 'heuristic',
      predict: (features) => {
        const v = features.vector;
        const attemptsNorm = at(v, COORD.CAMPAIGN_HISTORY.start + 0);
        const vulnClassSeen = at(v, COORD.CAMPAIGN_HISTORY.start + 1);
        const alreadyConfirmed = at(v, COORD.CAMPAIGN_HISTORY.start + 2);
        return (1 - attemptsNorm) * 0.4 + (1 - alreadyConfirmed) * 0.3 + (1 - vulnClassSeen) * 0.3;
      },
    };
  },
};

function at(vector: readonly number[], idx: number): number {
  const value = vector[idx];
  if (value === undefined || value === MISSING) return 0;
  return value;
}
