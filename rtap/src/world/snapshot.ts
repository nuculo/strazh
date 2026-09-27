import { createHash } from 'node:crypto';
import type { RecommendationBinding } from '../domain/recommendation-binding.js';
import type { CampaignWorldState } from './state.js';
import { fingerprint } from './fingerprint.js';

const FORMAT_VERSION = '1.0.0';

/**
 * FROZEN_INTEGRATION.md §7's exact snapshot shape: "campaign/world ID; last event
 * sequence; world fingerprint; epoch; ModelSnapshot and WorldBinding; cryptographic
 * digest; format version." `modelSnapshotRef` is `SignedModelArtifact.modelRef`
 * (training/model-artifact.ts); `worldBinding` is the `RecommendationBinding`
 * (domain/recommendation-binding.ts) active when the snapshot was taken — both
 * `null` when nothing was bound yet, which is a legitimate state, not an omission.
 *
 * Deliberately does NOT carry entities/relations. The doc is explicit that a
 * snapshot "never replaces canonical event history until retention and audit policy
 * explicitly allows compaction" — that policy decision hasn't been made, so this
 * type does not pretend to let a caller skip replay. What it gives you without
 * touching CampaignEventStore: (1) `restorePosition()`, the world's
 * generation/epoch/lastSequence/fingerprint, immediately; (2) `verifySnapshot()`, an
 * integrity check against a world you *did* fully reconstruct via world/replay.ts,
 * to confirm replay reproduced exactly what was snapshotted. Full state recovery is
 * still, by design, `replay()` — this is a checkpoint, not a shortcut around it.
 */
export interface WorldSnapshot {
  readonly formatVersion: string;
  readonly campaignId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly lastSequence: number;
  readonly fingerprint: string;
  readonly modelSnapshotRef: string | null;
  readonly worldBinding: RecommendationBinding | null;
  readonly takenAt: string;
  readonly digest: string;
}

interface SnapshotBody {
  readonly formatVersion: string;
  readonly campaignId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly lastSequence: number;
  readonly fingerprint: string;
  readonly modelSnapshotRef: string | null;
  readonly worldBinding: RecommendationBinding | null;
  readonly takenAt: string;
}

function digestOf(body: SnapshotBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function snapshotWorld(
  world: CampaignWorldState,
  context: { readonly modelSnapshotRef: string | null; readonly worldBinding: RecommendationBinding | null },
  now = new Date(),
): WorldSnapshot {
  const body: SnapshotBody = {
    formatVersion: FORMAT_VERSION,
    campaignId: world.campaignId,
    generation: world.generation,
    epoch: world.epoch,
    lastSequence: world.lastSequence,
    fingerprint: fingerprint(world),
    modelSnapshotRef: context.modelSnapshotRef,
    worldBinding: context.worldBinding,
    takenAt: now.toISOString(),
  };
  return { ...body, digest: digestOf(body) };
}

export interface SnapshotVerification {
  readonly valid: boolean;
  /** Present iff invalid: every field that disagreed between the snapshot and the live world. */
  readonly mismatches?: readonly string[];
}

/**
 * Recomputes the snapshot's digest two ways: (1) from the snapshot's own recorded
 * fields, to detect the record itself being tampered with in storage; (2) from a
 * live `world`, to detect the world having drifted from what was snapshotted. Both
 * are checked because they catch different failures — a corrupted snapshot row vs. a
 * world that no longer replays to what it once did.
 */
export function verifySnapshot(snapshot: WorldSnapshot, world?: CampaignWorldState): SnapshotVerification {
  const { digest, ...recordedBody } = snapshot;
  const mismatches: string[] = [];

  if (digestOf(recordedBody) !== digest) {
    mismatches.push('digest does not match snapshot body — snapshot record was tampered with or corrupted');
  }

  if (world) {
    if (world.campaignId !== snapshot.campaignId) mismatches.push('campaignId');
    if (world.generation !== snapshot.generation) mismatches.push('generation');
    if (world.epoch !== snapshot.epoch) mismatches.push('epoch');
    if (world.lastSequence !== snapshot.lastSequence) mismatches.push('lastSequence');
    if (fingerprint(world) !== snapshot.fingerprint) mismatches.push('fingerprint');
  }

  return mismatches.length === 0 ? { valid: true } : { valid: false, mismatches };
}

/** Cheap, replay-free recovery of *position* only — see the module doc comment for why this stops short of full state. */
export function restorePosition(snapshot: WorldSnapshot): { readonly generation: number; readonly epoch: number; readonly lastSequence: number; readonly fingerprint: string } {
  return { generation: snapshot.generation, epoch: snapshot.epoch, lastSequence: snapshot.lastSequence, fingerprint: snapshot.fingerprint };
}
