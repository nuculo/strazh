import type { DatabaseSync } from 'node:sqlite';
import type { RankedCandidate } from './rank.js';

export interface ShadowRankingRecord extends RankedCandidate {
  readonly campaignId: string;
  readonly targetId: string;
  readonly createdAt: string;
}

/**
 * Persists shadow rankings — ADAPTIVE_REDTEAM_RUNTIME.md §15 P3: "persisted shadow
 * ranking and counterfactual dashboard". This store has no method that creates a
 * RunStep and no dependency on RunStepStore — meta-harness-does-not-create-runstep
 * is enforced by this module simply never importing the thing that could violate it.
 */
export class ShadowRankingStore {
  constructor(private readonly db: DatabaseSync) {}

  persist(campaignId: string, targetId: string, ranked: readonly RankedCandidate[], now = new Date()): void {
    const createdAt = now.toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO shadow_rankings
         (campaign_id, target_id, candidate_probe_id, model_ref, world_generation, world_epoch, predicted_utility, rank, quality, signal_json, created_at)
       VALUES
         (@campaignId, @targetId, @candidateProbeId, @modelRef, @worldGeneration, @worldEpoch, @predictedUtility, @rank, @quality, @signalJson, @createdAt)`,
    );
    for (const r of ranked) {
      stmt.run({
        campaignId,
        targetId,
        candidateProbeId: r.probeId,
        modelRef: r.signal.modelRef,
        worldGeneration: r.signal.worldGeneration,
        worldEpoch: r.signal.worldEpoch,
        predictedUtility: r.signal.value,
        rank: r.rank,
        quality: r.signal.quality,
        signalJson: JSON.stringify(r.signal),
        createdAt,
      });
    }
  }

  listByTarget(campaignId: string, targetId: string): ShadowRankingRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM shadow_rankings WHERE campaign_id = @campaignId AND target_id = @targetId ORDER BY created_at ASC, rank ASC`)
      .all({ campaignId, targetId }) as {
      campaign_id: string;
      target_id: string;
      candidate_probe_id: string;
      signal_json: string;
      rank: number;
      created_at: string;
    }[];
    return rows.map((r) => ({
      campaignId: r.campaign_id,
      targetId: r.target_id,
      probeId: r.candidate_probe_id,
      signal: JSON.parse(r.signal_json),
      rank: r.rank,
      createdAt: r.created_at,
    }));
  }
}
