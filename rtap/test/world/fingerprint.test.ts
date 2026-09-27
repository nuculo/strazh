import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/world/fingerprint.js';
import { replay } from '../../src/world/replay.js';
import type { CampaignWorldState } from '../../src/world/state.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';

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

describe('fingerprint', () => {
  it('is a 64-char hex sha256', () => {
    const world = replay([event(0, 't1', 'p1:s1', 'VULNERABLE')], 'campaign-1').world;
    expect(fingerprint(world)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('two independent replays of the same events produce the same fingerprint', () => {
    const events = [event(0, 't1', 'p1:s1', 'VULNERABLE'), event(1, 't2', 'p2:s1', 'RESISTANT')];
    const a = fingerprint(replay(events, 'campaign-1').world);
    const b = fingerprint(replay(events, 'campaign-1').world);
    expect(a).toBe(b);
  });

  it('is independent of world generation', () => {
    const events = [event(0, 't1', 'p1:s1', 'VULNERABLE')];
    const gen0 = fingerprint(replay(events, 'campaign-1', 0).world);
    const gen9 = fingerprint(replay(events, 'campaign-1', 9).world);
    expect(gen0).toBe(gen9);
  });

  it('a different event sequence produces a different fingerprint', () => {
    const a = fingerprint(replay([event(0, 't1', 'p1:s1', 'VULNERABLE')], 'campaign-1').world);
    const b = fingerprint(replay([event(0, 't1', 'p1:s1', 'RESISTANT')], 'campaign-1').world);
    expect(a).not.toBe(b);
  });

  it('is independent of Map/array insertion order — same entities and relations, inserted in reverse, fingerprint identically', () => {
    const base: Omit<CampaignWorldState, 'entities' | 'relations'> = {
      campaignId: 'campaign-1',
      generation: 0,
      epoch: 2,
      lastSequence: 1,
      appliedEventIds: new Set(['e0', 'e1']),
      scheduledUnresolved: new Set(),
    };
    const entitiesForward = new Map([
      ['t1', { id: 't1', type: 'Target' as const, firstSeenSequence: 0, lastUpdatedSequence: 0 }],
      ['t2', { id: 't2', type: 'Target' as const, firstSeenSequence: 1, lastUpdatedSequence: 1 }],
    ]);
    const entitiesBackward = new Map([...entitiesForward].reverse());
    const relationsForward = [
      { type: 'PROBE_TESTS_TARGET' as const, sourceId: 'p1', targetId: 't1', confidence: 1, sequence: 0 },
      { type: 'PROBE_TESTS_TARGET' as const, sourceId: 'p2', targetId: 't2', confidence: 1, sequence: 1 },
    ];
    const relationsBackward = [...relationsForward].reverse();

    const worldForward: CampaignWorldState = { ...base, entities: entitiesForward, relations: relationsForward };
    const worldBackward: CampaignWorldState = { ...base, entities: entitiesBackward, relations: relationsBackward };

    expect(fingerprint(worldForward)).toBe(fingerprint(worldBackward));
  });
});
