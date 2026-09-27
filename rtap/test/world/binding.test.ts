import { describe, expect, it } from 'vitest';
import { worldPositionOf, worldFingerprintOf } from '../../src/world/binding.js';
import { replay } from '../../src/world/replay.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';

function event(sequence: number): CampaignEventEnvelope {
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
    payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' },
  };
}

describe('worldPositionOf', () => {
  it('reflects the world epoch and generation, replacing the Phase 3 placeholder', () => {
    const world = replay([event(0), event(1), event(2)], 'campaign-1', 3).world;
    expect(worldPositionOf(world)).toEqual({ worldGeneration: 3, worldEpoch: 3 });
  });
});

describe('worldFingerprintOf', () => {
  it('matches fingerprint() directly', () => {
    const world = replay([event(0)], 'campaign-1').world;
    expect(worldFingerprintOf(world)).toMatch(/^[a-f0-9]{64}$/);
  });
});
