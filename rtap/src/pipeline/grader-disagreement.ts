import { createHash } from 'node:crypto';
import type { WorldPosition, FrozenSignal } from '../shadow/signal.js';

export interface GradedObservation {
  readonly id: string;
  readonly verdict: string;
  readonly engineId: string;
  readonly graderRan: boolean;
}

export const GRADER_DISAGREEMENT_MODEL_REF = 'deterministic:grader-disagreement-v1';

function digestOfIds(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join(',')).digest('hex');
}

/**
 * FROZEN_INTEGRATION.md §5.4 `GRADER_DISAGREEMENT`: "deterministic comparison of
 * grader verdicts on equivalent inputs — Canonical Correlator, not frozen —
 * surfaced through CampaignWorld." Lives in `pipeline/`, not `shadow/`, for that
 * reason: its producer is the Correlator's own grouping unit
 * (`pipeline/correlate.ts`'s `(targetId, probeId)` key), not a model or
 * CampaignWorld state read — it still emits a `FrozenSignal` because that is the
 * one signal envelope every consumer reads, regardless of producer (§5.4's own
 * producer-mapping table).
 *
 * "Equivalent inputs" means the same `(targetId, probeId)` pair graded by more
 * than one *distinct engine* — a single engine's own repeated verdicts on the
 * same pair are not "grader disagreement" (that would be non-determinism within
 * one grader, a different, uncovered phenomenon), and an ungraded/UNVERIFIED
 * result contributes no opinion to compare —
 * `redteam.observation/unverified-data-is-not-a-positive-label`'s own principle,
 * extended here: missing evidence is not an opinion, agreeing or disagreeing.
 */
export function computeGraderDisagreement(
  targetId: string,
  probeId: string,
  observations: readonly GradedObservation[],
  world: WorldPosition,
  quality: FrozenSignal['quality'] = 'SHADOW',
): FrozenSignal {
  const graded = observations.filter((o) => o.graderRan && o.verdict !== 'UNVERIFIED');
  const evidenceObservationIds = graded.map((o) => o.id);
  const base = {
    kind: 'GRADER_DISAGREEMENT' as const,
    subjectRef: `${targetId}:${probeId}`,
    targetId,
    quality,
    evidenceObservationIds,
    modelRef: GRADER_DISAGREEMENT_MODEL_REF,
    adapterRef: null,
    worldGeneration: world.worldGeneration,
    worldEpoch: world.worldEpoch,
    featureSnapshotRef: `observations:${digestOfIds(evidenceObservationIds)}`,
  };

  const distinctEngines = new Set(graded.map((o) => o.engineId));
  if (distinctEngines.size < 2) {
    return { ...base, value: 0, reasonCodes: distinctEngines.size === 0 ? ['no-graded-evidence'] : ['single-grader-only'] };
  }

  const verdictCounts = new Map<string, number>();
  for (const o of graded) verdictCounts.set(o.verdict, (verdictCounts.get(o.verdict) ?? 0) + 1);
  const maxCount = Math.max(...verdictCounts.values());
  const disagreement = 1 - maxCount / graded.length;

  const reasonCodes = [...verdictCounts.entries()].sort((a, b) => b[1] - a[1]).map(([verdict, count]) => `${verdict}:${count}`);
  return { ...base, value: disagreement, reasonCodes };
}
