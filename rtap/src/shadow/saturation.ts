import type { CampaignWorldState, RelationRecord } from '../world/state.js';
import { fingerprint } from '../world/fingerprint.js';
import type { FrozenSignal } from './signal.js';

export const SATURATION_MODEL_REF = 'deterministic:saturation-v1';
const DEFAULT_WINDOW_SIZE = 5;

function relationsAboutTarget(world: CampaignWorldState, targetId: string): readonly RelationRecord[] {
  return world.relations.filter((r) => r.sourceId === targetId || r.targetId === targetId);
}

/**
 * FROZEN_INTEGRATION.md §5.4 `SATURATION`: "declining marginal new-information
 * rate over a window ... CampaignWorld coverage/event stats — no model required."
 * Scoped per-target, not whole-campaign — "the campaign overall is declining" is
 * not, on its own, something a per-target planner decision can act on, but
 * "Target X's marginal returns are declining" directly is, and `FrozenSignal`
 * already requires a `targetId` (the target-scoped-binding audit fix).
 *
 * "New information" here means a `RelationRecord` touching this target first
 * observed inside a given window. `RelationRecord.sequence` is fixed at first
 * observation — `world/reducer.ts` dedupes by `relationKey()` and never updates an
 * already-known relation's own `sequence` — so it is exactly "when this fact was
 * first learned," not "when it was last confirmed." Compares two *consecutive*
 * equal-size windows (recent vs. the one before it), not window-vs-lifetime
 * average: a target that has always had a slow trickle of new facts is not
 * "declining," one whose rate just dropped between the two most recent windows
 * is — that is what "declining" actually means for a rate, not a static
 * threshold on the absolute count.
 */
export function computeSaturation(world: CampaignWorldState, targetId: string, windowSize = DEFAULT_WINDOW_SIZE, quality: FrozenSignal['quality'] = 'SHADOW'): FrozenSignal {
  const totalEvents = world.lastSequence + 1;
  const base = {
    kind: 'SATURATION' as const,
    subjectRef: targetId,
    targetId,
    quality,
    evidenceObservationIds: [],
    modelRef: SATURATION_MODEL_REF,
    adapterRef: null,
    featureSnapshotRef: `world:${fingerprint(world)}`,
    worldGeneration: world.generation,
    worldEpoch: world.epoch,
  };

  if (totalEvents < windowSize * 2) {
    return { ...base, value: 0, reasonCodes: ['insufficient-history'] };
  }

  const relations = relationsAboutTarget(world, targetId);
  const recentStart = totalEvents - windowSize;
  const previousStart = totalEvents - windowSize * 2;
  const recentCount = relations.filter((r) => r.sequence >= recentStart).length;
  const previousCount = relations.filter((r) => r.sequence >= previousStart && r.sequence < recentStart).length;

  if (previousCount === 0) {
    // Nothing new in the earlier window either — either nothing has ever been
    // learned about this target yet (absence of data, not saturation) or it was
    // already fully saturated before this window pair. Either way there is no
    // rate to compare against; report 0 rather than dividing by zero into a
    // fabricated 1.0.
    return { ...base, value: 0, reasonCodes: recentCount === 0 ? ['no-new-information-in-either-window'] : ['no-baseline-rate-to-compare-against'] };
  }

  const recentRate = recentCount / windowSize;
  const previousRate = previousCount / windowSize;
  const saturation = Math.max(0, Math.min(1, 1 - recentRate / previousRate));

  return {
    ...base,
    value: saturation,
    reasonCodes: [`previous-window-new-relations:${previousCount}`, `recent-window-new-relations:${recentCount}`],
  };
}
