import type { CampaignEventEnvelope } from '../events/store.js';
import { applyEvent, type ApplyError } from './reducer.js';
import { emptyWorld, type CampaignWorldState } from './state.js';

export interface ReplayResult {
  readonly world: CampaignWorldState;
  /** Non-empty iff replay stopped early — a sequence gap or illegal relation. Never a crash. */
  readonly stoppedAt: { readonly sequence: number; readonly error: ApplyError } | null;
  readonly eventsApplied: number;
}

/**
 * "Event sequence gaps stop materialization and trigger replay; they are not
 * skipped" (FROZEN_INTEGRATION.md §6) — this *is* that replay path: rebuild from
 * `emptyWorld`, apply events strictly in sequence order, and stop (not skip) the
 * first time one doesn't fit. Filters to `campaignId` and sorts by `sequence` itself
 * so callers don't have to pre-sort a multi-campaign event log correctly.
 */
export function replay(events: readonly CampaignEventEnvelope[], campaignId: string, generation = 0): ReplayResult {
  let world = emptyWorld(campaignId, generation);
  let eventsApplied = 0;

  const ordered = events.filter((e) => e.campaignId === campaignId).sort((a, b) => a.sequence - b.sequence);

  for (const event of ordered) {
    const result = applyEvent(world, event);
    if (!result.ok) {
      return { world, stoppedAt: { sequence: event.sequence, error: result.error }, eventsApplied };
    }
    if (result.world !== world) eventsApplied += 1; // idempotent replays of an already-applied id don't double-count
    world = result.world;
  }

  return { world, stoppedAt: null, eventsApplied };
}
