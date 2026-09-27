/**
 * ADAPTIVE_REDTEAM_RUNTIME.md §10, §9.2 EXPERIMENTAL row: "bounded share". This is
 * the PlannerPolicySnapshot FROZEN_INTEGRATION.md §5.5/§10.2 refers to — versioned,
 * because a weight/share change is a policy change subject to review, same
 * discipline as UtilityLabelPolicy (Phase 2).
 */
export interface PlannerPolicy {
  readonly policyVersion: string;
  /** Fraction of the non-mandatory batch the model arm may claim. EXPERIMENTAL-only bound — CALIBRATED removes it (promotion/types.ts authorityFor().boundedShare). */
  readonly modelShareCap: number;
  /** Fraction of the non-mandatory batch reserved for exploration. Never configured to 0. */
  readonly explorationShare: number;
  readonly maxBatchSize: number;
}

export const DEFAULT_EXPERIMENTAL_POLICY: PlannerPolicy = {
  policyVersion: '1.0.0',
  modelShareCap: 0.3,
  explorationShare: 0.15,
  maxBatchSize: 20,
};

export function validatePolicy(policy: PlannerPolicy): void {
  if (policy.explorationShare <= 0) {
    throw new Error(`PlannerPolicy ${policy.policyVersion} has explorationShare <= 0 — the exploration arm must never be configured away`);
  }
  if (policy.modelShareCap < 0 || policy.modelShareCap > 1) {
    throw new Error(`PlannerPolicy ${policy.policyVersion} has modelShareCap out of [0,1]: ${policy.modelShareCap}`);
  }
  if (policy.modelShareCap + policy.explorationShare > 1) {
    throw new Error(`PlannerPolicy ${policy.policyVersion} over-commits: modelShareCap + explorationShare > 1`);
  }
  if (policy.maxBatchSize < 1) {
    throw new Error(`PlannerPolicy ${policy.policyVersion} has maxBatchSize < 1`);
  }
}
