import { describe, expect, it } from 'vitest';
import { replay } from '../../src/world/replay.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';

function event(sequence: number, targetId: string, probeId: string, verdict: string, campaignId = 'campaign-1'): CampaignEventEnvelope {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${campaignId}-${sequence}`,
    campaignId,
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

describe('replay', () => {
  it('rebuilds a world identical to sequential applyEvent calls', () => {
    const events = [event(0, 't1', 'p1:s1', 'VULNERABLE'), event(1, 't1', 'p2:s1', 'RESISTANT'), event(2, 't2', 'p1:s1', 'UNVERIFIED')];
    const result = replay(events, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
    expect(result.eventsApplied).toBe(3);
    expect(result.world.epoch).toBe(3);
    expect(result.world.entities.size).toBe(5); // t1, t2, p1, p2, finding:t1:p1:s1
  });

  it('sorts out-of-order input events before replaying', () => {
    const events = [event(2, 't1', 'p3:s1', 'RESISTANT'), event(0, 't1', 'p1:s1', 'RESISTANT'), event(1, 't1', 'p2:s1', 'RESISTANT')];
    const result = replay(events, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
    expect(result.eventsApplied).toBe(3);
  });

  it('filters to the requested campaignId only', () => {
    const events = [event(0, 't1', 'p1:s1', 'RESISTANT', 'campaign-1'), event(0, 't9', 'p9:s1', 'VULNERABLE', 'campaign-2')];
    const result = replay(events, 'campaign-1');
    expect(result.world.entities.has('t9')).toBe(false);
  });

  it('stops (not skips) at the first sequence gap and reports where', () => {
    const events = [event(0, 't1', 'p1:s1', 'RESISTANT'), event(2, 't1', 'p2:s1', 'RESISTANT')]; // gap at 1
    const result = replay(events, 'campaign-1');
    expect(result.stoppedAt).not.toBeNull();
    expect(result.stoppedAt?.sequence).toBe(2);
    expect(result.eventsApplied).toBe(1);
    expect(result.world.lastSequence).toBe(0);
  });

  it('an empty event list produces the empty world, epoch 0', () => {
    const result = replay([], 'campaign-1');
    expect(result.world.epoch).toBe(0);
    expect(result.world.lastSequence).toBe(-1);
    expect(result.stoppedAt).toBeNull();
  });

  it('respects the requested generation', () => {
    const result = replay([], 'campaign-1', 5);
    expect(result.world.generation).toBe(5);
  });
});
