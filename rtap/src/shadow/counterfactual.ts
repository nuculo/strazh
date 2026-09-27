import type { CampaignHistoryView } from '../features/history-view.js';
import { compileCandidateFeatures, type BudgetState } from '../features/candidate-compiler.js';
import { enumerateEligibleCandidates, DEFAULT_ELIGIBILITY_POLICY, type EligibilityPolicy } from '../candidates/enumerate.js';
import type { ProbeCatalogEntry } from '../candidates/catalog.js';
import { rankCandidates, type RankedCandidate } from './rank.js';
import { randomBaseline } from '../training/baselines/random-baseline.js';
import { heuristicBaseline } from '../training/baselines/heuristic-baseline.js';
import type { FittedModel } from '../training/baselines/types.js';
import type { WorldPosition } from './signal.js';

export interface CounterfactualRecord {
  readonly targetId: string;
  readonly actualProbeId: string;
  readonly actualLabel: number;
  readonly modelRank: number | null;
  readonly heuristicRank: number | null;
  readonly randomRank: number | null;
  readonly eligibleCount: number;
  readonly modelWasBest: boolean;
}

/**
 * ADAPTIVE_REDTEAM_RUNTIME.md §9.1: "The comparison record joins: Frozen
 * recommendation and rank + actual probe selected by the active non-model policy +
 * actual verified utility outcome + heuristic and random baseline ranks." Built
 * strictly from `historyBefore` (the same world-before-execution reconstruction
 * Phase 2 uses) plus the probe catalog — this never looks at what actually happened
 * to compute the ranking, only to compute where the actual choice landed in it.
 */
export function buildCounterfactual(
  model: FittedModel,
  modelRef: string,
  catalog: readonly ProbeCatalogEntry[],
  targetId: string,
  actualProbeId: string,
  actualLabel: number,
  historyBefore: CampaignHistoryView,
  world: WorldPosition,
  budget: BudgetState,
  policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
): CounterfactualRecord {
  // The actually-chosen probe must appear in the candidate set even if the policy
  // would otherwise have excluded it (e.g. it was mandatory, or eligibility rules
  // changed) — otherwise "where did the actual choice rank" is unanswerable.
  const eligibility = enumerateEligibleCandidates(catalog, targetId, historyBefore, policy);
  const probeIds = new Set(eligibility.eligible.map((c) => c.probeId));
  if (!probeIds.has(actualProbeId)) {
    probeIds.add(actualProbeId);
  }

  const features = [...probeIds].map((probeId) => compileCandidateFeatures({ targetId, probe: { probeId }, budget }, historyBefore));

  const modelRanking = rankCandidates(model, modelRef, features, world, 'SHADOW');
  const heuristicRanking = rankCandidates(heuristicBaseline.fit([]), 'heuristic', features, world, 'SHADOW');
  const randomRanking = rankCandidates(randomBaseline.fit([]), 'random', features, world, 'SHADOW');

  const rankOf = (ranking: { ranked: RankedCandidate[] }) => ranking.ranked.find((r) => r.probeId === actualProbeId)?.rank ?? null;

  const modelRank = rankOf(modelRanking);

  return {
    targetId,
    actualProbeId,
    actualLabel,
    modelRank,
    heuristicRank: rankOf(heuristicRanking),
    randomRank: rankOf(randomRanking),
    eligibleCount: features.length,
    modelWasBest: modelRank === 1,
  };
}
