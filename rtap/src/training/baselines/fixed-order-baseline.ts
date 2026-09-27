import { vulnerabilityClassOf } from '../../features/history-view.js';
import type { Baseline, FittedModel } from './types.js';

/**
 * FROZEN_INTEGRATION.md §8.3 "fixed taxonomy order". A small, hand-picked priority
 * list — not sourced from promptfoo's real `constants/frameworks.ts` severity
 * mapping (that would cross the same ACL boundary PromptfooAdapter exists to keep:
 * RTAP does not import promptfoo's taxonomy data structures). Documented as a
 * placeholder ordering, not presented as calibrated severity.
 */
const FIXED_PRIORITY: readonly string[] = [
  'harmful-cybercrime',
  'prompt-injection',
  'pii-leak',
  'jailbreak',
  'rbac',
  'harmful',
];

function priorityScore(vulnClass: string): number {
  const idx = FIXED_PRIORITY.indexOf(vulnClass);
  if (idx === -1) return 0; // unknown classes rank last, not randomly
  return 1 - idx / FIXED_PRIORITY.length;
}

export const fixedOrderBaseline: Baseline = {
  name: 'fixed-order',
  fit(): FittedModel {
    return {
      name: 'fixed-order',
      predict: (features) => priorityScore(vulnerabilityClassOf(features.candidateProbeId ?? '')),
    };
  },
};
