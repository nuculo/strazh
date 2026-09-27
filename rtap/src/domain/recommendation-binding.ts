/**
 * RecommendationBinding execution guard.
 * FROZEN_INTEGRATION.md §2, §6: execute() iff recommendation.binding == current.binding,
 * else reject_as_stale(). Identity fields require exact equality; worldEpoch alone is
 * checked against a policy-defined tolerance (default 0) to avoid livelock on a
 * fast-moving campaign.
 */

export interface RecommendationBinding {
  readonly campaignId: string;
  /**
   * A real bug, found by audit: this field did not exist until now, so a
   * recommendation for Target A's probe could pass decideExecution() and dispatch
   * against Target B — every other identity field matched (same campaign/world/
   * model/policy), and nothing here ever checked *which target* the recommendation
   * was actually for.
   */
  readonly targetId: string;
  readonly worldGeneration: number;
  readonly worldEpoch: number;
  readonly featureSchemaVersion: string;
  readonly modelDigest: string;
  readonly policyVersion: string;
}

export interface StalenessPolicy {
  /** Max allowed (current.worldEpoch - recommendation.worldEpoch). 0 = exact match. */
  readonly epochTolerance: number;
}

export const DEFAULT_STALENESS_POLICY: StalenessPolicy = { epochTolerance: 0 };

export type RejectionReason =
  | 'campaign-mismatch'
  | 'target-mismatch'
  | 'generation-mismatch'
  | 'feature-schema-mismatch'
  | 'model-mismatch'
  | 'policy-mismatch'
  | 'epoch-stale'
  | 'epoch-from-the-future';

export interface ExecutionDecision {
  readonly executable: boolean;
  readonly reason?: RejectionReason;
}

/**
 * `recommendation` is the binding recorded on the FrozenSignal/ProbeRecommendation at
 * the moment it was produced. `current` is the live world/model/policy state at the
 * moment the Planner is about to act. Identity fields never tolerate drift — a mismatch
 * there is a correctness bug, not staleness. Only worldEpoch has a tolerance, and a
 * recommendation from a *future* epoch (current is behind) is always rejected outright:
 * that can only happen from a binding recorded against a world that does not exist yet
 * on this replica, which is a stronger signal of a bug than ordinary staleness.
 */
export function decideExecution(
  recommendation: RecommendationBinding,
  current: RecommendationBinding,
  policy: StalenessPolicy = DEFAULT_STALENESS_POLICY,
): ExecutionDecision {
  if (recommendation.campaignId !== current.campaignId) {
    return { executable: false, reason: 'campaign-mismatch' };
  }
  if (recommendation.targetId !== current.targetId) {
    return { executable: false, reason: 'target-mismatch' };
  }
  if (recommendation.worldGeneration !== current.worldGeneration) {
    return { executable: false, reason: 'generation-mismatch' };
  }
  if (recommendation.featureSchemaVersion !== current.featureSchemaVersion) {
    return { executable: false, reason: 'feature-schema-mismatch' };
  }
  if (recommendation.modelDigest !== current.modelDigest) {
    return { executable: false, reason: 'model-mismatch' };
  }
  if (recommendation.policyVersion !== current.policyVersion) {
    return { executable: false, reason: 'policy-mismatch' };
  }
  if (recommendation.worldEpoch > current.worldEpoch) {
    return { executable: false, reason: 'epoch-from-the-future' };
  }
  const drift = current.worldEpoch - recommendation.worldEpoch;
  if (drift > policy.epochTolerance) {
    return { executable: false, reason: 'epoch-stale' };
  }
  return { executable: true };
}
