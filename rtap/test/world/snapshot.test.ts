import { describe, expect, it } from 'vitest';
import { replay } from '../../src/world/replay.js';
import { snapshotWorld, verifySnapshot, restorePosition } from '../../src/world/snapshot.js';
import { emptyWorld } from '../../src/world/state.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';
import type { RecommendationBinding } from '../../src/domain/recommendation-binding.js';

function event(sequence: number, targetId: string, probeId: string, verdict: string): CampaignEventEnvelope {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${sequence}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    sequence,
    occurredAt: '2026-08-30T00:00:00.000Z',
    committedAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId, probeId, verdict },
  };
}

describe('snapshotWorld / verifySnapshot', () => {
  const binding: RecommendationBinding = {
    campaignId: 'campaign-1',
    worldGeneration: 0,
    worldEpoch: 2,
    featureSchemaVersion: '1.0.0',
    modelDigest: 'deadbeef',
    policyVersion: '1.0.0',
  };

  it('produces the FROZEN_INTEGRATION.md §7 fields, format version, and a digest', () => {
    const world = replay([event(0, 't1', 'p1:s1', 'VULNERABLE')], 'campaign-1').world;
    const snapshot = snapshotWorld(world, { modelSnapshotRef: 'model-1', worldBinding: binding });

    expect(snapshot.formatVersion).toBe('1.0.0');
    expect(snapshot.campaignId).toBe('campaign-1');
    expect(snapshot.lastSequence).toBe(0);
    expect(snapshot.epoch).toBe(1);
    expect(snapshot.modelSnapshotRef).toBe('model-1');
    expect(snapshot.worldBinding).toEqual(binding);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allows null modelSnapshotRef/worldBinding as a legitimate unbound state', () => {
    const world = emptyWorld('campaign-1');
    const snapshot = snapshotWorld(world, { modelSnapshotRef: null, worldBinding: null });
    expect(snapshot.modelSnapshotRef).toBeNull();
    expect(snapshot.worldBinding).toBeNull();
    expect(verifySnapshot(snapshot).valid).toBe(true);
  });

  it('verifies against the exact world it was taken from', () => {
    const world = replay([event(0, 't1', 'p1:s1', 'VULNERABLE'), event(1, 't1', 'p2:s1', 'RESISTANT')], 'campaign-1').world;
    const snapshot = snapshotWorld(world, { modelSnapshotRef: null, worldBinding: null });
    expect(verifySnapshot(snapshot, world)).toEqual({ valid: true });
  });

  it('detects a world that has drifted since the snapshot was taken', () => {
    const worldAtSnapshot = replay([event(0, 't1', 'p1:s1', 'VULNERABLE')], 'campaign-1').world;
    const snapshot = snapshotWorld(worldAtSnapshot, { modelSnapshotRef: null, worldBinding: null });
    const laterWorld = replay([event(0, 't1', 'p1:s1', 'VULNERABLE'), event(1, 't1', 'p2:s1', 'RESISTANT')], 'campaign-1').world;

    const result = verifySnapshot(snapshot, laterWorld);
    expect(result.valid).toBe(false);
    expect(result.mismatches).toContain('epoch');
    expect(result.mismatches).toContain('lastSequence');
    expect(result.mismatches).toContain('fingerprint');
  });

  it('detects a tampered snapshot record even with no world to compare against', () => {
    const world = emptyWorld('campaign-1');
    const snapshot = snapshotWorld(world, { modelSnapshotRef: null, worldBinding: null });
    const tampered = { ...snapshot, epoch: snapshot.epoch + 1 };
    expect(verifySnapshot(tampered).valid).toBe(false);
  });

  it('restorePosition() reads position fields without needing a world', () => {
    const world = replay([event(0, 't1', 'p1:s1', 'VULNERABLE')], 'campaign-1', 3).world;
    const snapshot = snapshotWorld(world, { modelSnapshotRef: null, worldBinding: null });
    expect(restorePosition(snapshot)).toEqual({
      generation: 3,
      epoch: world.epoch,
      lastSequence: world.lastSequence,
      fingerprint: snapshot.fingerprint,
    });
  });
});
