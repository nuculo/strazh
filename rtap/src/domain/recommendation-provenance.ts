import { fingerprint } from '../world/fingerprint.js';
import type { CampaignWorldState } from '../world/state.js';

/**
 * Audit finding #3's remainder — traceability fields for a recommendation,
 * additional to `RecommendationBinding`'s own strict-equality composite key
 * (FROZEN_INTEGRATION.md §2/§6, `recommendation-binding.ts`). None of these are
 * ever checked for equality by `decideExecution()` — a mismatch here is not what
 * makes a recommendation stale; `RecommendationBinding` alone still decides that.
 * This is deliberately a *record of provenance*, not a second staleness gate —
 * the same relationship `AuthorizationReceipt`'s `approvedAt`/`expiresAt`
 * (`execution/authorization.ts`) has to the identity fields it also carries.
 *
 * Scoped to fields this repo can genuinely produce today. The audit's own list
 * named three more this file deliberately omits — `candidateId`,
 * `modelGeneration`, `targetSnapshotRef` — because nothing in this codebase
 * produces real values for them: a candidate is identified only by the
 * `(targetId, probeId)` pair (`features/history-view.ts`'s `targetProbeKey()`),
 * a model is identified only by `modelDigest`, a content hash
 * (`training/model-artifact.ts`), with no separate generation counter anywhere
 * in `promotion/registry.ts`, and nothing in the planner/shadow path produces a
 * target snapshot reference — unlike `execution/authorization.ts`'s
 * `AuthorizeEffectRequest.targetSnapshotRef`, which a caller supplies from
 * outside, there is no equivalent caller in this pipeline yet. Adding those
 * three here would mean inventing values with nothing behind them; this repo's
 * own convention (see rtap/README.md's other bug-fix sections) is to document a
 * real gap rather than fabricate a plausible-looking field.
 */
export interface RecommendationProvenance {
  /**
   * `fingerprint(world)` at the moment this recommendation was produced —
   * content, not just position. `RecommendationBinding` already carries
   * `(worldGeneration, worldEpoch)`, but two different event histories can only
   * reach the same `(generation, epoch)` pair if something has gone wrong
   * upstream; the fingerprint is what makes that detectable instead of merely
   * assumed impossible.
   */
  readonly worldFingerprint: string;
  /**
   * The same value as the `FrozenSignal.featureSnapshotRef` this recommendation
   * was scored from (`shadow/signal.ts`) — itself `candidate-compiler.ts`'s own
   * synthesized ref (a documented placeholder, not a real content-addressed
   * store; see `signal.ts`'s own doc comment). Re-surfaced here under the
   * audit's field name rather than computed separately, since it already *is*
   * the closest real thing to a feature digest this repo has.
   */
  readonly featureDigest: string;
  /** `features/candidate-compiler.ts`'s `CANDIDATE_COMPILER_BUILD` — the one compiler build every `CandidateFeatureSnapshot` in this repo is currently stamped with (not a per-candidate hash; there is only one build at a time). */
  readonly compilerDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Default validity window: 5 minutes — long enough to survive a normal dispatch cycle, short enough that a provenance record left lying around does not read as fresh indefinitely. Mirrors `evaluateAuthorization()`'s `receiptDurationMs` pattern (`execution/authorization.ts`); this is a separate, independently-tunable window, not the same clock. */
const DEFAULT_PROVENANCE_TTL_MS = 5 * 60_000;

export function buildRecommendationProvenance(
  world: CampaignWorldState,
  featureSnapshotRef: string,
  compilerDigest: string,
  now = new Date(),
  ttlMs = DEFAULT_PROVENANCE_TTL_MS,
): RecommendationProvenance {
  return {
    worldFingerprint: fingerprint(world),
    featureDigest: featureSnapshotRef,
    compilerDigest,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

/** Mirrors `execution/authorization.ts`'s `isReceiptValid()`. A lapsed TTL is not itself a staleness rejection — `RecommendationBinding`/`decideExecution()` still decide that independently — it is a signal a caller *may* choose to treat as one. */
export function isProvenanceFresh(provenance: RecommendationProvenance, now = new Date()): boolean {
  return now.getTime() < new Date(provenance.expiresAt).getTime();
}
