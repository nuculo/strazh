import { targetProbeKey, type CampaignHistoryView } from '../features/history-view.js';

/**
 * FROZEN_INTEGRATION.md §8.1: "The utility formula that produces the label ... is a
 * versioned policy artifact, not code embedded in the training pipeline." This is
 * that artifact — plain data, reviewable and diffable independent of a retrain. A
 * weight change is a policy version bump, not a silent side effect.
 */
export interface UtilityLabelPolicy {
  readonly policyVersion: string;
  readonly weights: {
    readonly newConfirmedFinding: number;
    readonly independentConfirmation: number;
    readonly uncertaintyReduction: number;
    readonly normalizedCost: number;
    readonly executionOrGraderError: number;
  };
}

export const DEFAULT_UTILITY_POLICY: UtilityLabelPolicy = {
  policyVersion: '1.0.0',
  weights: {
    newConfirmedFinding: 1.0,
    independentConfirmation: 0.3,
    uncertaintyReduction: 0.2,
    normalizedCost: 0.1,
    executionOrGraderError: 0.5,
  },
};

export interface LabelInput {
  readonly targetId: string;
  readonly probeId: string;
  readonly verdict: string;
}

/**
 * Pure function of (policy, observed outcome, history strictly before that outcome).
 * Every term is computable from data this repo actually has today — no fabricated
 * signal (real target-call cost/latency are not tracked yet, so `normalizedCost` is
 * a flat per-attempt unit, documented here rather than silently invented as
 * something more precise than it is).
 *
 * `alreadyConfirmed`/`priorAttempts` are looked up by `(targetId, probeId)`, not
 * bare `probeId` — a real bug found by audit: a confirmed VULNERABLE on one Target
 * must not turn a first-ever attempt of the same probe against a different Target
 * into a mislabeled `independentConfirmation` instead of a genuine
 * `newConfirmedFinding`.
 */
export function computeUtilityLabel(policy: UtilityLabelPolicy, outcome: LabelInput, historyBefore: CampaignHistoryView): number {
  const key = targetProbeKey(outcome.targetId, outcome.probeId);
  const alreadyConfirmed = historyBefore.confirmedFindingTargetProbes.has(key);
  const priorAttempts = historyBefore.byTargetProbe.get(key)?.committedOutcomes ?? 0;

  const newConfirmedFinding = outcome.verdict === 'VULNERABLE' && !alreadyConfirmed ? 1 : 0;
  const independentConfirmation = outcome.verdict === 'VULNERABLE' && alreadyConfirmed ? 1 : 0;
  const uncertaintyReduction = priorAttempts === 0 ? 1 : 0;
  const normalizedCost = 1; // flat unit cost per attempt — real cost tracking is a later gap, not guessed here.
  const executionOrGraderError = outcome.verdict === 'ERROR' || outcome.verdict === 'UNVERIFIED' ? 1 : 0;

  const w = policy.weights;
  return (
    w.newConfirmedFinding * newConfirmedFinding +
    w.independentConfirmation * independentConfirmation +
    w.uncertaintyReduction * uncertaintyReduction -
    w.normalizedCost * normalizedCost -
    w.executionOrGraderError * executionOrGraderError
  );
}
