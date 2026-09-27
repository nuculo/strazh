import type { CandidateFeatureSnapshot } from '../features/candidate-compiler.js';
import type { FittedModel } from '../training/baselines/types.js';
import { heuristicBaseline } from '../training/baselines/heuristic-baseline.js';
import { scoreCandidate, type FrozenSignal, type WorldPosition } from './signal.js';

export interface RankedCandidate {
  readonly targetId: string;
  readonly probeId: string;
  readonly signal: FrozenSignal;
  readonly rank: number;
}

export interface RankingResult {
  readonly ranked: RankedCandidate[];
  readonly usedFallback: boolean;
  readonly fallbackReason: string | null;
}

const FALLBACK_MODEL_REF = 'heuristic-fallback-v1';

/**
 * redteam.planner/frozen-failure-falls-back-to-heuristic. If the primary model
 * throws on *any* candidate in the batch, the whole batch falls back to the
 * deterministic heuristic baseline — never a partial mix of model-scored and
 * heuristic-scored candidates in the same ranking, which would make the ranking
 * internally incomparable. This function itself never throws.
 */
export function rankCandidates(
  model: FittedModel,
  modelRef: string,
  candidates: readonly CandidateFeatureSnapshot[],
  world: WorldPosition,
  quality: FrozenSignal['quality'],
): RankingResult {
  let signals: FrozenSignal[];
  let usedFallback = false;
  let fallbackReason: string | null = null;

  try {
    signals = candidates.map((c) => scoreCandidate(model, modelRef, c, world, quality));
  } catch (err) {
    usedFallback = true;
    fallbackReason = err instanceof Error ? err.message : String(err);
    const fallbackModel = heuristicBaseline.fit([]);
    signals = candidates.map((c) => scoreCandidate(fallbackModel, FALLBACK_MODEL_REF, c, world, quality));
  }

  const withProbeId = signals.map((signal, i) => ({ targetId: candidates[i]!.candidateTargetId, probeId: candidates[i]!.candidateProbeId, signal }));
  withProbeId.sort((a, b) => b.signal.value - a.signal.value);

  const ranked: RankedCandidate[] = withProbeId.map((entry, i) => ({ ...entry, rank: i + 1 }));

  return { ranked, usedFallback, fallbackReason };
}
