import type { CampaignEventEnvelope } from '../events/store.js';
import { targetProbeKey, vulnerabilityClassOf } from '../features/history-view.js';
import { isLegalRelation, type RelationType } from './graph-schema.js';
import type { CampaignWorldState, EntityRecord, RelationRecord } from './state.js';

export type ApplyError =
  | { readonly kind: 'wrong-campaign'; readonly detail: string }
  | { readonly kind: 'sequence-gap'; readonly detail: string }
  | { readonly kind: 'illegal-relation'; readonly detail: string };

export type ApplyResult = { readonly ok: true; readonly world: CampaignWorldState } | { readonly ok: false; readonly error: ApplyError };

interface Derived {
  readonly entities: EntityRecord[];
  readonly relations: RelationRecord[];
}

/**
 * Everything this reducer can derive from the event payload shape
 * `{targetId, probeId, verdict}` that observation-event.ts actually commits today.
 * Total: an event whose payload doesn't have that shape (a future event type this
 * repo hasn't wired a producer for yet) still gets its sequence/epoch/idempotency
 * bookkeeping applied — it just contributes no graph delta. That is a real,
 * documented gap (Strategy/SecurityControl/Domain/ModelVersion entities and their
 * relation types are declared in graph-schema.ts but never produced here), not a
 * silent one.
 */
function deriveFromPayload(event: CampaignEventEnvelope): Derived {
  const payload = event.payload as { targetId?: unknown; probeId?: unknown; verdict?: unknown };
  if (typeof payload.targetId !== 'string' || typeof payload.probeId !== 'string') {
    return { entities: [], relations: [] };
  }

  const targetId = payload.targetId;
  const probeClassId = vulnerabilityClassOf(payload.probeId);
  const entities: EntityRecord[] = [
    { id: targetId, type: 'Target', firstSeenSequence: event.sequence, lastUpdatedSequence: event.sequence },
    { id: probeClassId, type: 'ProbeClass', firstSeenSequence: event.sequence, lastUpdatedSequence: event.sequence },
  ];
  const relations: RelationRecord[] = [
    { type: 'PROBE_TESTS_TARGET', sourceId: probeClassId, targetId: targetId, confidence: 1, sequence: event.sequence },
  ];

  if (payload.verdict === 'VULNERABLE') {
    const findingId = `finding:${targetId}:${payload.probeId}`;
    entities.push({ id: findingId, type: 'Finding', firstSeenSequence: event.sequence, lastUpdatedSequence: event.sequence });
    relations.push({ type: 'TARGET_EXPOSES_FINDING', sourceId: targetId, targetId: findingId, confidence: 1, sequence: event.sequence });
  }

  return { entities, relations };
}

function mergeEntity(entities: ReadonlyMap<string, EntityRecord>, incoming: EntityRecord): Map<string, EntityRecord> {
  const next = new Map(entities);
  const existing = next.get(incoming.id);
  next.set(incoming.id, existing ? { ...existing, lastUpdatedSequence: incoming.lastUpdatedSequence } : incoming);
  return next;
}

function relationKey(r: { type: RelationType; sourceId: string; targetId: string }): string {
  return `${r.type}:${r.sourceId}:${r.targetId}`;
}

/**
 * FROZEN_INTEGRATION.md §6 consistency rules, made real:
 *  1. duplicate eventId is idempotent — returns the *same* world unchanged;
 *  2. a sequence gap is rejected, not skipped;
 *  3. every accepted state-changing event advances epoch;
 *  4. an illegal relation (graph-schema.ts) is rejected before merging, the whole
 *     event is rejected, not partially applied.
 */
export function applyEvent(world: CampaignWorldState, event: CampaignEventEnvelope): ApplyResult {
  if (event.campaignId !== world.campaignId) {
    return { ok: false, error: { kind: 'wrong-campaign', detail: `world is for ${world.campaignId}, event is for ${event.campaignId}` } };
  }
  if (world.appliedEventIds.has(event.eventId)) {
    return { ok: true, world };
  }

  const expectedSequence = world.lastSequence + 1;
  if (event.sequence !== expectedSequence) {
    return {
      ok: false,
      error: { kind: 'sequence-gap', detail: `expected sequence ${expectedSequence}, got ${event.sequence}` },
    };
  }

  const derived = deriveFromPayload(event);
  for (const relation of derived.relations) {
    const sourceType = derived.entities.find((e) => e.id === relation.sourceId)?.type ?? world.entities.get(relation.sourceId)?.type;
    const targetType = derived.entities.find((e) => e.id === relation.targetId)?.type ?? world.entities.get(relation.targetId)?.type;
    if (!sourceType || !targetType || !isLegalRelation({ type: relation.type, sourceType, targetType })) {
      return {
        ok: false,
        error: { kind: 'illegal-relation', detail: `${relation.type} ${relation.sourceId}(${sourceType}) -> ${relation.targetId}(${targetType}) is not declared in graph-schema.ts` },
      };
    }
  }

  let entities = world.entities;
  for (const e of derived.entities) entities = mergeEntity(entities, e);

  const existingKeys = new Set(world.relations.map(relationKey));
  const newRelations = derived.relations.filter((r) => !existingKeys.has(relationKey(r)));
  const relations = newRelations.length > 0 ? [...world.relations, ...newRelations] : world.relations;

  return {
    ok: true,
    world: {
      ...world,
      epoch: world.epoch + 1,
      lastSequence: event.sequence,
      appliedEventIds: new Set(world.appliedEventIds).add(event.eventId),
      entities,
      relations,
      scheduledUnresolved: nextScheduledUnresolved(world.scheduledUnresolved, event),
    },
  };
}

/** Every event type that resolves a scheduled probe's outcome — the four `eventForObservation()` can emit, one per `Verdict`. */
const RESOLVING_EVENT_TYPES: ReadonlySet<string> = new Set(['VulnerabilityObserved', 'ResistanceObserved', 'ObservationUnverified', 'ExecutionFailed']);

/**
 * The coverage denominator's bookkeeping (ARCH_CLAUDE_TRANSFER.md §2.4):
 * `ProbeScheduled` adds a `(targetId, probeId)` to the outstanding set, and any of
 * the four resolving event types removes it. `ExecutionFailed` counts as resolved on
 * purpose — a probe that ran and errored is a *known* outcome, and conflating it with
 * one that never ran is exactly the ambiguity this set exists to remove.
 *
 * Deliberately a pure function of `(previous set, event)`, like everything else in
 * this reducer, so it replays identically and needs no separate persistence.
 */
function nextScheduledUnresolved(current: ReadonlySet<string>, event: CampaignEventEnvelope): ReadonlySet<string> {
  const payload = event.payload as { targetId?: unknown; probeId?: unknown };
  if (typeof payload.targetId !== 'string' || typeof payload.probeId !== 'string') return current;
  const key = targetProbeKey(payload.targetId, payload.probeId);

  if (event.eventType === 'ProbeScheduled') {
    if (current.has(key)) return current;
    return new Set(current).add(key);
  }
  if (RESOLVING_EVENT_TYPES.has(event.eventType) && current.has(key)) {
    const next = new Set(current);
    next.delete(key);
    return next;
  }
  return current;
}
