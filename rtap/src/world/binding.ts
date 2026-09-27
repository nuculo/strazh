import type { CampaignWorldState } from './state.js';
import type { WorldPosition } from '../shadow/signal.js';
import { fingerprint } from './fingerprint.js';

/**
 * The real `WorldPosition` a CampaignWorldState is at — replaces the placeholder
 * `{worldGeneration: 0, worldEpoch: allEvents.length}` Phase 3's own tests used
 * before this module existed (recommendation-binding.ts's `worldGeneration`/
 * `worldEpoch` fields were designed in Phase 0 against this exact shape, ahead of
 * there being a real producer for it — this is that producer).
 */
export function worldPositionOf(world: CampaignWorldState): WorldPosition {
  return { worldGeneration: world.generation, worldEpoch: world.epoch };
}

export function worldFingerprintOf(world: CampaignWorldState): string {
  return fingerprint(world);
}
