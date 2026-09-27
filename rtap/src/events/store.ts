import type { DatabaseSync } from 'node:sqlite';
import { validate } from '../schemas/index.js';

/**
 * Input to append() — everything the caller decides. `sequence` and `committedAt`
 * are assigned by the store, not the caller: only the store knows the current max
 * sequence for a campaign, and only the store's clock defines commit time.
 */
export interface CampaignEventInput {
  readonly schemaVersion: string;
  readonly eventId: string;
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly sourceObservationIds: string[];
  readonly featureSnapshotRef: string | null;
  readonly taxonomySnapshotRef: string | null;
  readonly payload: Record<string, unknown>;
}

export interface CampaignEventEnvelope extends CampaignEventInput {
  readonly sequence: number;
  readonly committedAt: string;
}

export interface AppendResult {
  readonly event: CampaignEventEnvelope;
  /** True when eventId had already been committed — this call was a no-op. */
  readonly deduped: boolean;
}

/**
 * Append-only CampaignEvent log. FROZEN_INTEGRATION.md §3.3, §7: duplicate eventId is
 * idempotent; sequence is monotonic per campaignId; every appended event is validated
 * against the rtap:campaign-event schema before it is accepted — an invalid event
 * cannot enter the log silently.
 *
 * Phase 1 scope: this only stores events. Nothing reads them back into a
 * CampaignWorld yet — that is Phase 4 (FROZEN_INTEGRATION.md §12 F4). Right now this
 * is exactly what ARCHITECTURE.md §9 Phase 1 calls "frozen пока replay-only fixture":
 * a real, durable, schema-validated event log with nothing downstream consuming it.
 *
 * Audit finding #4: every event appended here also gets an `outbox` row,
 * unconditionally, in the same statement sequence — since `append()` never opens
 * its own transaction (a bare `INSERT`, participating in whatever ambient
 * transaction a caller like `commitFencedObservation()` has open, or autocommitting
 * if none), this makes "Observation + CampaignEvent + OutboxRow, atomic commit"
 * (ADAPTIVE_REDTEAM_RUNTIME.md §6) true for every committed event without either
 * commit function needing to know the outbox exists. See `events/outbox.ts` for
 * the consumer side and `world/materializer.ts` for the durable publisher that
 * reads it.
 */
export class CampaignEventStore {
  constructor(private readonly db: DatabaseSync) {}

  append(input: CampaignEventInput, now = new Date()): AppendResult {
    const existing = this.getByEventId(input.eventId);
    if (existing) {
      return { event: existing, deduped: true };
    }

    const nextSequence = this.nextSequence(input.campaignId);
    const envelope: CampaignEventEnvelope = {
      ...input,
      sequence: nextSequence,
      committedAt: now.toISOString(),
    };

    const result = validate('rtap:campaign-event', envelope);
    if (!result.valid) {
      throw new Error(`Refusing to append an invalid CampaignEvent: ${result.errors.join('; ')}`);
    }

    this.db
      .prepare(
        `INSERT INTO campaign_events
           (event_id, campaign_id, sequence, event_type, schema_version, assessment_run_id,
            feature_snapshot_ref, taxonomy_snapshot_ref, body_json, occurred_at, committed_at)
         VALUES (@eventId, @campaignId, @sequence, @eventType, @schemaVersion, @assessmentRunId,
                 @featureSnapshotRef, @taxonomySnapshotRef, @bodyJson, @occurredAt, @committedAt)`,
      )
      .run({
        eventId: envelope.eventId,
        campaignId: envelope.campaignId,
        sequence: envelope.sequence,
        eventType: envelope.eventType,
        schemaVersion: envelope.schemaVersion,
        assessmentRunId: envelope.assessmentRunId,
        featureSnapshotRef: envelope.featureSnapshotRef,
        taxonomySnapshotRef: envelope.taxonomySnapshotRef,
        bodyJson: JSON.stringify(envelope),
        occurredAt: envelope.occurredAt,
        committedAt: envelope.committedAt,
      });

    this.db
      .prepare(`INSERT INTO outbox (event_id, campaign_id, sequence, created_at, delivered_at) VALUES (@eventId, @campaignId, @sequence, @createdAt, NULL)`)
      .run({ eventId: envelope.eventId, campaignId: envelope.campaignId, sequence: envelope.sequence, createdAt: envelope.committedAt });

    return { event: envelope, deduped: false };
  }

  getByEventId(eventId: string): CampaignEventEnvelope | null {
    const row = this.db.prepare(`SELECT body_json FROM campaign_events WHERE event_id = @eventId`).get({ eventId }) as
      | { body_json: string }
      | undefined;
    return row ? (JSON.parse(row.body_json) as CampaignEventEnvelope) : null;
  }

  listByCampaign(campaignId: string): CampaignEventEnvelope[] {
    const rows = this.db
      .prepare(`SELECT body_json FROM campaign_events WHERE campaign_id = @campaignId ORDER BY sequence ASC`)
      .all({ campaignId }) as { body_json: string }[];
    return rows.map((r) => JSON.parse(r.body_json) as CampaignEventEnvelope);
  }

  private nextSequence(campaignId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(sequence) as maxSeq FROM campaign_events WHERE campaign_id = @campaignId`)
      .get({ campaignId }) as { maxSeq: number | null };
    return (row.maxSeq ?? -1) + 1;
  }
}
