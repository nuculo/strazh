import type { DatabaseSync } from 'node:sqlite';
import type { CampaignEventStore } from '../events/store.js';
import { OutboxStore } from '../events/outbox.js';
import { applyEvent, type ApplyError } from './reducer.js';
import { emptyWorld, type CampaignWorldState, type EntityRecord, type RelationRecord } from './state.js';
import { replay } from './replay.js';
import { snapshotWorld, verifySnapshot } from './snapshot.js';
import { SnapshotStore } from './snapshot-store.js';

export interface MaterializeResult {
  readonly world: CampaignWorldState;
  /** Non-empty iff materialization stopped early — a sequence gap or illegal relation. Never a crash. */
  readonly stoppedAt: { readonly sequence: number; readonly error: ApplyError } | null;
  readonly eventsApplied: number;
}

interface StoredState {
  readonly campaignId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly lastSequence: number;
  readonly entities: EntityRecord[];
  readonly relations: RelationRecord[];
  readonly appliedEventIds: string[];
  /** Optional: rows persisted before the coverage denominator existed carry no such field. */
  readonly scheduledUnresolved?: string[];
}

function serialize(world: CampaignWorldState): string {
  const stored: StoredState = {
    campaignId: world.campaignId,
    generation: world.generation,
    epoch: world.epoch,
    lastSequence: world.lastSequence,
    entities: [...world.entities.values()],
    relations: [...world.relations],
    appliedEventIds: [...world.appliedEventIds],
    scheduledUnresolved: [...world.scheduledUnresolved],
  };
  return JSON.stringify(stored);
}

function deserialize(json: string): CampaignWorldState {
  const stored = JSON.parse(json) as StoredState;
  return {
    campaignId: stored.campaignId,
    generation: stored.generation,
    epoch: stored.epoch,
    lastSequence: stored.lastSequence,
    entities: new Map(stored.entities.map((e) => [e.id, e])),
    relations: stored.relations,
    appliedEventIds: new Set(stored.appliedEventIds),
    // Older persisted rows predate this field; an absent value is an empty set, not a crash.
    scheduledUnresolved: new Set(stored.scheduledUnresolved ?? []),
  };
}

/**
 * Audit finding #4: the incremental half of the outbox pattern —
 * ADAPTIVE_REDTEAM_RUNTIME.md §6's "durable publisher + incremental materializer +
 * persisted cursor," as opposed to `world/replay.ts`'s `replay()`, which rebuilds
 * from `emptyWorld` every time. `replay()` is unchanged and still the right tool for
 * full reconstruction and verification (see `world/snapshot.ts`'s
 * `verifySnapshot()`); this class is for the steady-state path: pick up wherever the
 * last `advance()` left off, whether that was a moment ago or after a crash.
 *
 * The persisted cursor *is* `materialized_worlds.last_sequence` — there is no
 * separate cursor row. `advance()` derives "what's pending" by asking the outbox for
 * everything undelivered past that sequence, which makes a crash between persisting
 * the world and marking rows delivered self-healing: on the next `advance()`, those
 * rows are still undelivered, `applyEvent()`'s own idempotency (an eventId already in
 * `appliedEventIds` is a no-op) absorbs the redundant re-application, and they get
 * marked delivered again. The only way to lose progress is to lose the database file
 * itself — the same guarantee every other store in this repo relies on.
 *
 * грань №14 (`Грани Arch_claude`): the one gap that guarantee didn't cover was
 * `materialized_worlds.state_json` being corrupted while the file itself survives —
 * a bit-flip, a partial write outside any transaction this class controls. `current()`
 * now verifies each read against a `WorldSnapshot` (`world/snapshot.ts`,
 * `world/snapshot-store.ts`) taken in the same transaction as the write, and falls
 * back to `replay()` on disagreement instead of returning corrupted data or throwing.
 */
export class CampaignWorldMaterializer {
  private readonly outbox: OutboxStore;
  private readonly snapshots: SnapshotStore;

  constructor(
    private readonly db: DatabaseSync,
    private readonly events: CampaignEventStore,
    outbox?: OutboxStore,
    snapshots?: SnapshotStore,
  ) {
    this.outbox = outbox ?? new OutboxStore(db);
    this.snapshots = snapshots ?? new SnapshotStore(db);
  }

  /**
   * The last persisted world for `campaignId`, or `null` if `advance()` has never
   * been called for it. грань №14: no longer a pure watermark read. `state_json`
   * that fails to parse, or that parses but disagrees with the last snapshot
   * `advance()` took alongside it, is corruption — this falls back to a full
   * `replay()` from the canonical event log rather than throwing or returning a
   * wrong world. A campaign with no snapshot row yet (predates this migration, or
   * its first `advance()` applied zero events) skips verification, same graceful
   * degradation `scheduledUnresolved`'s own optional-field handling already uses.
   */
  current(campaignId: string): CampaignWorldState | null {
    const row = this.db.prepare(`SELECT state_json FROM materialized_worlds WHERE campaign_id = @campaignId`).get({ campaignId }) as { state_json: string } | undefined;
    if (!row) return null;

    let world: CampaignWorldState;
    try {
      world = deserialize(row.state_json);
    } catch {
      return replay(this.events.listByCampaign(campaignId), campaignId).world;
    }

    const snapshot = this.snapshots.get(campaignId);
    if (snapshot && !verifySnapshot(snapshot, world).valid) {
      return replay(this.events.listByCampaign(campaignId), campaignId).world;
    }

    return world;
  }

  advance(campaignId: string, now = new Date()): MaterializeResult {
    let world = this.current(campaignId) ?? emptyWorld(campaignId);

    const pending = this.outbox
      .listUndelivered(campaignId)
      .filter((entry) => entry.sequence > world.lastSequence);

    let eventsApplied = 0;
    let stoppedAt: MaterializeResult['stoppedAt'] = null;
    const delivered: string[] = [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of pending) {
        const envelope = this.events.getByEventId(entry.eventId);
        if (!envelope) {
          // Outbox row exists but the event body doesn't — the ambient transaction that
          // wrote both hasn't committed yet from this connection's point of view. Stop,
          // don't skip; the next advance() will see it once it has.
          break;
        }

        const result = applyEvent(world, envelope);
        if (!result.ok) {
          stoppedAt = { sequence: envelope.sequence, error: result.error };
          break;
        }
        if (result.world !== world) eventsApplied += 1;
        world = result.world;
        delivered.push(entry.eventId);
      }

      this.db
        .prepare(
          `INSERT INTO materialized_worlds (campaign_id, generation, epoch, last_sequence, state_json, updated_at)
           VALUES (@campaignId, @generation, @epoch, @lastSequence, @stateJson, @updatedAt)
           ON CONFLICT(campaign_id) DO UPDATE SET generation = @generation, epoch = @epoch, last_sequence = @lastSequence, state_json = @stateJson, updated_at = @updatedAt`,
        )
        .run({
          campaignId,
          generation: world.generation,
          epoch: world.epoch,
          lastSequence: world.lastSequence,
          stateJson: serialize(world),
          updatedAt: now.toISOString(),
        });

      // грань №14: a snapshot only when the world actually changed — an unchanged
      // world's existing snapshot (if any) still describes it exactly, so rewriting
      // an identical row would be pure waste, never a correctness gap. Same
      // transaction as the materialized_worlds write above, so the two can never
      // disagree after a crash — current()'s verification depends on that.
      if (eventsApplied > 0) {
        this.snapshots.save(snapshotWorld(world, { modelSnapshotRef: null, worldBinding: null }, now));
      }

      this.outbox.markDelivered(delivered, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { world, stoppedAt, eventsApplied };
  }

  /**
   * ARCH_CLAUDE_TRANSFER.md §2.6. The watermark is deliberately not a new column or
   * table — it *is* `materialized_worlds.last_sequence`, the exact cursor `advance()`
   * itself already trusts, so pruning can never race ahead of what has genuinely been
   * materialized: a row `advance()` still needs is, by construction, never eligible.
   * A campaign with no persisted world yet (`current()` returns `null`) has no safe
   * watermark to prune against and is left untouched, not pruned to `-Infinity`.
   */
  pruneDeliveredOutbox(campaignId: string): number {
    const world = this.current(campaignId);
    if (!world) return 0;
    return this.outbox.pruneDelivered(campaignId, world.lastSequence);
  }
}
