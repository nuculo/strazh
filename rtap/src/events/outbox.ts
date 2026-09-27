import type { DatabaseSync } from 'node:sqlite';

/**
 * Audit finding #4: the durable half of the outbox pattern. Rows are written by
 * `CampaignEventStore.append()` (`events/store.ts`), never here — this store only
 * reads and marks delivery. That split matters: the writer runs inside whatever
 * transaction committed the event, so a row exists iff the event does; this reader
 * runs independently, from `world/materializer.ts`, and can fall arbitrarily far
 * behind (a crash between event commit and materialization) without losing anything
 * — `listUndelivered()` is exactly the recovery query for that gap.
 */
export interface OutboxEntry {
  readonly eventId: string;
  readonly campaignId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

interface OutboxRow {
  event_id: string;
  campaign_id: string;
  sequence: number;
  created_at: string;
  delivered_at: string | null;
}

function fromRow(row: OutboxRow): OutboxEntry {
  return {
    eventId: row.event_id,
    campaignId: row.campaign_id,
    sequence: row.sequence,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export class OutboxStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Rows not yet marked delivered for `campaignId`, ordered by sequence — the exact backlog a materializer must catch up on. */
  listUndelivered(campaignId: string): OutboxEntry[] {
    const rows = this.db
      .prepare(`SELECT event_id, campaign_id, sequence, created_at, delivered_at FROM outbox WHERE campaign_id = @campaignId AND delivered_at IS NULL ORDER BY sequence ASC`)
      .all({ campaignId }) as unknown as OutboxRow[];
    return rows.map(fromRow);
  }

  listAll(campaignId: string): OutboxEntry[] {
    const rows = this.db
      .prepare(`SELECT event_id, campaign_id, sequence, created_at, delivered_at FROM outbox WHERE campaign_id = @campaignId ORDER BY sequence ASC`)
      .all({ campaignId }) as unknown as OutboxRow[];
    return rows.map(fromRow);
  }

  /** Idempotent — marking an already-delivered or nonexistent eventId again is a no-op, not an error. */
  markDelivered(eventIds: readonly string[], now = new Date()): void {
    if (eventIds.length === 0) return;
    const deliveredAt = now.toISOString();
    const stmt = this.db.prepare(`UPDATE outbox SET delivered_at = @deliveredAt WHERE event_id = @eventId AND delivered_at IS NULL`);
    for (const eventId of eventIds) {
      stmt.run({ eventId, deliveredAt });
    }
  }

  /**
   * ARCH_CLAUDE_TRANSFER.md §2.6: `outbox` grows monotonically forever with nothing
   * in `src/` ever deleting from it. `delivered_at IS NOT NULL` is the safety
   * guarantee, not an optimization — `listUndelivered()` filters on exactly that
   * column, so a row this predicate would ever touch was already invisible to every
   * real reader. `throughSequence` is a caller-supplied watermark, not derived here —
   * see `world/materializer.ts`'s `pruneDeliveredOutbox()` for the one caller that
   * derives it safely, from the same cursor `advance()` itself trusts.
   */
  pruneDelivered(campaignId: string, throughSequence: number): number {
    const result = this.db
      .prepare(`DELETE FROM outbox WHERE campaign_id = @campaignId AND delivered_at IS NOT NULL AND sequence <= @throughSequence`)
      .run({ campaignId, throughSequence });
    return Number(result.changes);
  }
}
