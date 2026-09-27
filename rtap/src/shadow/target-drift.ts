import { createHash } from 'node:crypto';
import { COORD, newVector } from '../features/coordinates.js';
import { MISSING, isMissing } from '../features/missing.js';
import { compileObservationFeatures, type ObservationForFeatures } from '../features/observation-compiler.js';
import type { CampaignHistoryView } from '../features/history-view.js';
import type { WorldPosition, FrozenSignal } from './signal.js';

export const TARGET_DRIFT_MODEL_REF = 'deterministic:target-drift-v1';
/**
 * Deliberately explicit, not derived — §5.4: "baseline, threshold and reason
 * codes must be built explicitly." Every real coordinate is normalized to [0, 1]
 * (`features/missing.ts`), so a per-coordinate difference of up to 1 is possible;
 * this is a real, chosen operating threshold, not a statistically-fit one — there
 * is no production data yet to fit one against.
 */
export const DEFAULT_DRIFT_THRESHOLD = 0.3;

const COORD_GROUP_NAMES = Object.keys(COORD) as (keyof typeof COORD)[];

function digestOfIds(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join(',')).digest('hex');
}

function coordinateGroupOf(index: number): string {
  for (const name of COORD_GROUP_NAMES) {
    const { start, count } = COORD[name];
    if (index >= start && index < start + count) return name;
  }
  return 'UNKNOWN';
}

/** Mean per coordinate across `observations`, MISSING-excluded — averaging the sentinel would corrupt the real signal, not just skew it. A coordinate with zero real contributions across the whole set stays MISSING. */
function aggregateVector(observations: readonly ObservationForFeatures[], history: CampaignHistoryView): number[] {
  const sums = newVector(0);
  const counts = newVector(0);
  for (const obs of observations) {
    const { vector } = compileObservationFeatures(obs, history);
    for (let i = 0; i < vector.length; i += 1) {
      const value = vector[i]!;
      if (isMissing(value)) continue;
      sums[i] = sums[i]! + value;
      counts[i] = counts[i]! + 1;
    }
  }
  return sums.map((s, i) => (counts[i]! > 0 ? s / counts[i]! : MISSING));
}

/**
 * FROZEN_INTEGRATION.md §5.4 `TARGET_DRIFT`: "statistical distance between current
 * and reference V60 aggregates ... baseline/threshold/reason codes built
 * explicitly, the runtime only supplies state storage and geometry." Aggregates
 * both the "current" and "reference" observation windows through the exact same
 * `ObservationFeatureCompiler` already used for training
 * (`features/observation-compiler.ts`) — reusing the real 60-coordinate geometry
 * the doc says the runtime supplies, not a separate ad hoc encoding.
 *
 * Distance is Euclidean over coordinates present (non-MISSING) in *both*
 * aggregates. A coordinate MISSING in one window and real in the other is a real
 * gap this cannot yet compare (no baseline for that dimension in one of the two
 * windows) — excluded from the distance rather than treated as either agreement
 * or maximal disagreement, since neither would be true.
 */
export function computeTargetDrift(
  targetId: string,
  currentObservations: readonly ObservationForFeatures[],
  referenceObservations: readonly ObservationForFeatures[],
  history: CampaignHistoryView,
  world: WorldPosition,
  quality: FrozenSignal['quality'] = 'SHADOW',
  threshold = DEFAULT_DRIFT_THRESHOLD,
): FrozenSignal {
  const evidenceObservationIds = [...currentObservations, ...referenceObservations].map((o) => o.id);
  const base = {
    kind: 'TARGET_DRIFT' as const,
    subjectRef: targetId,
    targetId,
    quality,
    evidenceObservationIds,
    modelRef: TARGET_DRIFT_MODEL_REF,
    adapterRef: null,
    worldGeneration: world.worldGeneration,
    worldEpoch: world.worldEpoch,
    featureSnapshotRef: `observations:${digestOfIds(evidenceObservationIds)}`,
  };

  if (currentObservations.length === 0 || referenceObservations.length === 0) {
    return { ...base, value: 0, reasonCodes: ['insufficient-data'] };
  }

  const current = aggregateVector(currentObservations, history);
  const reference = aggregateVector(referenceObservations, history);

  let sumSquares = 0;
  const perCoordDiffs: { index: number; diff: number }[] = [];
  for (let i = 0; i < current.length; i += 1) {
    if (isMissing(current[i]!) || isMissing(reference[i]!)) continue;
    const diff = current[i]! - reference[i]!;
    sumSquares += diff * diff;
    perCoordDiffs.push({ index: i, diff });
  }
  const distance = Math.sqrt(sumSquares);

  perCoordDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const topContributors = perCoordDiffs.slice(0, 3).map((d) => `${coordinateGroupOf(d.index)}[${d.index}]:${d.diff.toFixed(3)}`);
  const thresholdCode = distance >= threshold ? `drift-exceeds-threshold:${threshold}` : `drift-within-threshold:${threshold}`;

  return { ...base, value: distance, reasonCodes: [thresholdCode, ...topContributors] };
}
