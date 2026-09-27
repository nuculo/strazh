import { targetProbeKey } from '../features/history-view.js';
import type { EligibleCandidate } from '../candidates/enumerate.js';
import type { RankedCandidate } from '../shadow/rank.js';
import { decideExecution, type RecommendationBinding, type StalenessPolicy, DEFAULT_STALENESS_POLICY } from '../domain/recommendation-binding.js';
import { buildRecommendationProvenance, type RecommendationProvenance } from '../domain/recommendation-provenance.js';
import type { CampaignWorldState } from '../world/state.js';
import type { PlannerPolicy } from './policy.js';
import { validatePolicy } from './policy.js';

export type PlannerArm = 'mandatory' | 'model' | 'heuristic' | 'exploration';

export interface PlannerDecision {
  readonly targetId: string;
  readonly probeId: string;
  readonly arm: PlannerArm;
  readonly binding: RecommendationBinding | null;
  /** Audit #3 remainder — only ever non-null for the model arm, and only when `BindingContext` supplies both `world` and `compilerDigest`; see `domain/recommendation-provenance.ts`. */
  readonly provenance: RecommendationProvenance | null;
}

export interface MandatoryShortfallEntry {
  readonly targetId: string;
  readonly probeId: string;
}

export interface MixResult {
  readonly decisions: PlannerDecision[];
  readonly armCounts: Readonly<Record<PlannerArm, number>>;
  /** Eligible mandatory candidates that did not fit even after the batch consumed all available budget. Never silently dropped — reported. */
  readonly mandatoryShortfall: MandatoryShortfallEntry[];
  /** Model-arm candidates whose RecommendationBinding failed decideExecution() and were routed to heuristic/exploration instead. */
  readonly staleModelRecommendationsDropped: number;
}

export interface BindingContext {
  readonly campaignId: string;
  readonly featureSchemaVersion: string;
  readonly modelDigest: string;
  readonly policyVersion: string;
  /**
   * Optional — when both `world` and `compilerDigest` are supplied, a model-arm
   * decision also carries a `RecommendationProvenance` built from them (see
   * `domain/recommendation-provenance.ts`). Omitted by every existing caller
   * today, none of which has a real `CampaignWorldState` in hand at this call
   * site — additive, not required, so nothing that already constructs a
   * `BindingContext` needs to change.
   */
  readonly world?: CampaignWorldState;
  readonly compilerDigest?: string;
}

/**
 * `targetId` comes from the ranked candidate itself, not from a caller-supplied
 * "current" context — `decideExecution()`'s target-mismatch check exists precisely
 * to catch the case where a recommendation's own identity doesn't match what it's
 * about to be dispatched for (e.g. a caller-side mixup mis-attributing a Target A
 * recommendation to Target B), the same reason it already checked `campaignId`.
 */
function bindingFromRanked(r: RankedCandidate, ctx: BindingContext): RecommendationBinding {
  return {
    campaignId: ctx.campaignId,
    targetId: r.targetId,
    worldGeneration: r.signal.worldGeneration,
    worldEpoch: r.signal.worldEpoch,
    featureSchemaVersion: ctx.featureSchemaVersion,
    modelDigest: ctx.modelDigest,
    policyVersion: ctx.policyVersion,
  };
}

function provenanceFromRanked(r: RankedCandidate, ctx: BindingContext, now: Date): RecommendationProvenance | null {
  if (!ctx.world || ctx.compilerDigest === undefined) return null;
  return buildRecommendationProvenance(ctx.world, r.signal.featureSnapshotRef, ctx.compilerDigest, now);
}

function pickRandom<T>(rng: () => number, items: T[], count: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]!);
  }
  return picked;
}

/**
 * ADAPTIVE_REDTEAM_RUNTIME.md §10: mandatory, model, heuristic and exploration arms,
 * combined under a hard batch-size cap. Order of operations is the whole
 * specification:
 *
 *  1. mandatory candidates fill first, unconditionally — never ranked away, and
 *     never excluded for staleness (they don't come from the model);
 *  2. remaining budget = maxBatchSize - mandatory (never negative: excess mandatory
 *     candidates beyond the cap are reported as `mandatoryShortfall`, not silently
 *     dropped and not silently allowed to exceed budget — see README for why both
 *     invariants can't be satisfied simultaneously in that edge case and how this
 *     resolves it);
 *  3. exploration reserves its share of the remainder FIRST, before the model arm
 *     gets to claim anything — "never disappears" means never zero while there is
 *     room, not "gets whatever the model doesn't want";
 *  4. model arm claims up to `modelShareCap` of the remainder, filtered through
 *     `decideExecution` — a stale recommendation never becomes a RunStep, it falls
 *     through to heuristic instead;
 *  5. heuristic fills whatever is left.
 *
 * Total `decisions.length` never exceeds `policy.maxBatchSize` — checked by
 * construction (every slice below is bounded), not by a post-hoc trim.
 */
export function mixCandidates(
  eligible: readonly EligibleCandidate[],
  modelRanking: readonly RankedCandidate[],
  heuristicRanking: readonly RankedCandidate[],
  currentBinding: RecommendationBinding,
  bindingContext: BindingContext,
  policy: PlannerPolicy,
  rng: () => number,
  stalenessPolicy: StalenessPolicy = DEFAULT_STALENESS_POLICY,
  now = new Date(),
): MixResult {
  validatePolicy(policy);

  const decisions: PlannerDecision[] = [];
  // Composite (targetId, probeId) key — a bare probeId set would treat the same
  // probe requested for two different targets as one candidate, dropping one of
  // them from the batch. Real bug, found by audit.
  const chosenKeys = new Set<string>();

  const mandatoryEligible = eligible.filter((c) => c.mandatory);
  const mandatorySlots = Math.min(mandatoryEligible.length, policy.maxBatchSize);
  for (const c of mandatoryEligible.slice(0, mandatorySlots)) {
    decisions.push({ targetId: c.targetId, probeId: c.probeId, arm: 'mandatory', binding: null, provenance: null });
    chosenKeys.add(targetProbeKey(c.targetId, c.probeId));
  }
  const mandatoryShortfall: MandatoryShortfallEntry[] = mandatoryEligible.slice(mandatorySlots).map((c) => ({ targetId: c.targetId, probeId: c.probeId }));

  const remainingBudget = policy.maxBatchSize - decisions.length;

  const explorationCount = remainingBudget > 0 ? Math.max(1, Math.floor(remainingBudget * policy.explorationShare)) : 0;
  const explorationPool = eligible.filter((c) => !c.mandatory && !chosenKeys.has(targetProbeKey(c.targetId, c.probeId)));
  const explorationPicks = pickRandom(rng, explorationPool, Math.min(explorationCount, remainingBudget));
  for (const c of explorationPicks) {
    decisions.push({ targetId: c.targetId, probeId: c.probeId, arm: 'exploration', binding: null, provenance: null });
    chosenKeys.add(targetProbeKey(c.targetId, c.probeId));
  }

  const afterExploration = policy.maxBatchSize - decisions.length;
  const modelCount = Math.min(afterExploration, Math.floor(remainingBudget * policy.modelShareCap));

  let staleModelRecommendationsDropped = 0;
  const modelPicks: RankedCandidate[] = [];
  for (const r of modelRanking) {
    if (modelPicks.length >= modelCount) break;
    if (chosenKeys.has(targetProbeKey(r.targetId, r.probeId))) continue;
    const binding = bindingFromRanked(r, bindingContext);
    const decision = decideExecution(binding, currentBinding, stalenessPolicy);
    if (!decision.executable) {
      staleModelRecommendationsDropped += 1;
      continue;
    }
    modelPicks.push(r);
  }
  for (const r of modelPicks) {
    decisions.push({ targetId: r.targetId, probeId: r.probeId, arm: 'model', binding: bindingFromRanked(r, bindingContext), provenance: provenanceFromRanked(r, bindingContext, now) });
    chosenKeys.add(targetProbeKey(r.targetId, r.probeId));
  }

  const heuristicBudget = policy.maxBatchSize - decisions.length;
  const heuristicPicks = heuristicRanking.filter((r) => !chosenKeys.has(targetProbeKey(r.targetId, r.probeId))).slice(0, heuristicBudget);
  for (const r of heuristicPicks) {
    decisions.push({ targetId: r.targetId, probeId: r.probeId, arm: 'heuristic', binding: null, provenance: null });
    chosenKeys.add(targetProbeKey(r.targetId, r.probeId));
  }

  const armCounts: Record<PlannerArm, number> = { mandatory: 0, model: 0, heuristic: 0, exploration: 0 };
  for (const d of decisions) armCounts[d.arm] += 1;

  return { decisions, armCounts, mandatoryShortfall, staleModelRecommendationsDropped };
}
