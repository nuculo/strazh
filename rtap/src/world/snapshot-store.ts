import type { DatabaseSync } from 'node:sqlite';
import type { RecommendationBinding } from '../domain/recommendation-binding.js';
import type { WorldSnapshot } from './snapshot.js';

/**
 * The durable home грань №14 named as missing: `world/snapshot.ts`'s
 * `snapshotWorld()`/`verifySnapshot()` were proven-correct pure functions with no
 * table or store behind them until this. One row per campaign, upserted — same
 * `world_snapshots` migration doc comment explains why not a history.
 */
export class SnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  save(snapshot: WorldSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO world_snapshots (campaign_id, format_version, generation, epoch, last_sequence, fingerprint, model_snapshot_ref, world_binding, taken_at, digest)
         VALUES (@campaignId, @formatVersion, @generation, @epoch, @lastSequence, @fingerprint, @modelSnapshotRef, @worldBinding, @takenAt, @digest)
         ON CONFLICT(campaign_id) DO UPDATE SET
           format_version = @formatVersion, generation = @generation, epoch = @epoch,
           last_sequence = @lastSequence, fingerprint = @fingerprint,
           model_snapshot_ref = @modelSnapshotRef, world_binding = @worldBinding,
           taken_at = @takenAt, digest = @digest`,
      )
      .run({
        campaignId: snapshot.campaignId,
        formatVersion: snapshot.formatVersion,
        generation: snapshot.generation,
        epoch: snapshot.epoch,
        lastSequence: snapshot.lastSequence,
        fingerprint: snapshot.fingerprint,
        modelSnapshotRef: snapshot.modelSnapshotRef,
        worldBinding: snapshot.worldBinding ? JSON.stringify(snapshot.worldBinding) : null,
        takenAt: snapshot.takenAt,
        digest: snapshot.digest,
      });
  }

  get(campaignId: string): WorldSnapshot | null {
    const row = this.db.prepare(`SELECT * FROM world_snapshots WHERE campaign_id = @campaignId`).get({ campaignId }) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }
}

interface SnapshotRow {
  campaign_id: string;
  format_version: string;
  generation: number;
  epoch: number;
  last_sequence: number;
  fingerprint: string;
  model_snapshot_ref: string | null;
  world_binding: string | null;
  taken_at: string;
  digest: string;
}

function rowToSnapshot(row: SnapshotRow): WorldSnapshot {
  return {
    formatVersion: row.format_version,
    campaignId: row.campaign_id,
    generation: row.generation,
    epoch: row.epoch,
    lastSequence: row.last_sequence,
    fingerprint: row.fingerprint,
    modelSnapshotRef: row.model_snapshot_ref,
    worldBinding: row.world_binding ? (JSON.parse(row.world_binding) as RecommendationBinding) : null,
    takenAt: row.taken_at,
    digest: row.digest,
  };
}
