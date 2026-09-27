import type { EntityType, RelationType } from './graph-schema.js';

export interface EntityRecord {
  readonly id: string;
  readonly type: EntityType;
  readonly firstSeenSequence: number;
  readonly lastUpdatedSequence: number;
}

export interface RelationRecord {
  readonly type: RelationType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence: number;
  readonly sequence: number;
}

/**
 * FROZEN_INTEGRATION.md §3.2 mutable state, scoped to what this repo's own events
 * actually carry (see graph-schema.ts doc comment): entities, relations, an
 * event-sequence high-water-mark, epoch, generation, and the set of applied
 * eventIds (idempotency). No `memory` (episodic memory rings) or per-entity V60 —
 * both real, both not attempted here; FeatureCompiler (Phase 2) reads
 * CampaignHistoryView directly from CampaignEventStore today and does not need this
 * module to supply either.
 *
 * Immutable by convention: reducer.ts never mutates a CampaignWorldState in place,
 * it returns a new one. `entities`/`relations`/`appliedEventIds` are typed readonly
 * for the same reason state.ts's own aggregate types are — see
 * FROZEN_INTEGRATION.md §5.1's aggregate-boundary lesson, applied from day one here
 * instead of retrofitted.
 */
export interface CampaignWorldState {
  readonly campaignId: string;
  readonly generation: number;
  readonly epoch: number;
  /** -1 = no events applied yet. */
  readonly lastSequence: number;
  readonly entities: ReadonlyMap<string, EntityRecord>;
  readonly relations: readonly RelationRecord[];
  readonly appliedEventIds: ReadonlySet<string>;
  /**
   * Probes scheduled (`ProbeScheduled`) whose outcome has not yet been observed —
   * the coverage denominator, minus the numerator (ARCH_CLAUDE_TRANSFER.md §2.4).
   * Keyed by `features/history-view.ts`'s `targetProbeKey()` — reused rather than
   * re-derived, both so the two never drift and because its collision-safety lesson
   * applies unchanged here: a `probeId` legitimately contains `:`, so a naive
   * `${a}:${b}` join collides. (`reducer.ts` already imports from that module for
   * `vulnerabilityClassOf`, so this introduces no new dependency edge.)
   *
   * Non-empty at the end of a run means work was planned and never resolved — the
   * one fact that makes "no findings" distinguishable from "never ran".
   */
  readonly scheduledUnresolved: ReadonlySet<string>;
}

export function emptyWorld(campaignId: string, generation = 0): CampaignWorldState {
  return {
    campaignId,
    generation,
    epoch: 0,
    lastSequence: -1,
    entities: new Map(),
    relations: [],
    appliedEventIds: new Set(),
    scheduledUnresolved: new Set(),
  };
}
