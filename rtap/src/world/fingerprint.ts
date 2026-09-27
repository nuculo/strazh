import { createHash } from 'node:crypto';
import type { CampaignWorldState } from './state.js';

/**
 * FROZEN_INTEGRATION.md §6: "same ordered events produce the same state
 * fingerprint." Deliberately excludes `generation` — two independent replays of the
 * identical event sequence must fingerprint identically even if they happened in
 * different world lifetimes (see WorldGeneration in recommendation-binding.ts);
 * generation identifies *lineage*, fingerprint identifies *content*.
 */
export function fingerprint(world: CampaignWorldState): string {
  const canonical = {
    campaignId: world.campaignId,
    epoch: world.epoch,
    lastSequence: world.lastSequence,
    entities: [...world.entities.values()]
      .map((e) => ({ id: e.id, type: e.type }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    relations: [...world.relations]
      .map((r) => ({ type: r.type, sourceId: r.sourceId, targetId: r.targetId }))
      .sort((a, b) => {
        const ka = `${a.type}:${a.sourceId}:${a.targetId}`;
        const kb = `${b.type}:${b.sourceId}:${b.targetId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
    // Included deliberately: `scheduledUnresolved` is derived state like entities and
    // relations, so leaving it out would make the fingerprint blind to it — and
    // `redteam.platform/outbox-materialization-matches-full-replay` compares exactly
    // this hash, so an incremental/replay divergence in the coverage denominator
    // would pass unnoticed. Sorted for the same canonicalization reason as the rest.
    scheduledUnresolved: [...world.scheduledUnresolved].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
