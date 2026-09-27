import { describe, expect, it } from 'vitest';
import { applyEvent } from '../../src/world/reducer.js';
import { emptyWorld } from '../../src/world/state.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';

function event(overrides: Partial<CampaignEventEnvelope> & { sequence: number; payload: Record<string, unknown> }): CampaignEventEnvelope {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${overrides.sequence}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    committedAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    ...overrides,
  };
}

describe('applyEvent', () => {
  it('derives Target and ProbeClass entities and a PROBE_TESTS_TARGET relation', () => {
    const world = emptyWorld('campaign-1');
    const result = applyEvent(world, event({ sequence: 0, payload: { targetId: 't1', probeId: 'prompt-injection:base64', verdict: 'RESISTANT' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.entities.get('t1')).toMatchObject({ type: 'Target' });
    expect(result.world.entities.get('prompt-injection')).toMatchObject({ type: 'ProbeClass' });
    expect(result.world.relations).toContainEqual(
      expect.objectContaining({ type: 'PROBE_TESTS_TARGET', sourceId: 'prompt-injection', targetId: 't1' }),
    );
  });

  it('a VULNERABLE verdict also derives a Finding entity and TARGET_EXPOSES_FINDING relation', () => {
    const world = emptyWorld('campaign-1');
    const result = applyEvent(world, event({ sequence: 0, payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'VULNERABLE' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const findingId = 'finding:t1:p1:s1';
    expect(result.world.entities.get(findingId)).toMatchObject({ type: 'Finding' });
    expect(result.world.relations).toContainEqual(expect.objectContaining({ type: 'TARGET_EXPOSES_FINDING', sourceId: 't1', targetId: findingId }));
  });

  it('a RESISTANT verdict does not derive a Finding', () => {
    const world = emptyWorld('campaign-1');
    const result = applyEvent(world, event({ sequence: 0, payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.relations.some((r) => r.type === 'TARGET_EXPOSES_FINDING')).toBe(false);
  });

  it('advances epoch by exactly 1 per accepted event', () => {
    const world = emptyWorld('campaign-1');
    const first = applyEvent(world, event({ sequence: 0, payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' } }));
    expect(first.ok && first.world.epoch).toBe(1);
    if (!first.ok) return;
    const second = applyEvent(first.world, event({ sequence: 1, payload: { targetId: 't1', probeId: 'p2:s1', verdict: 'RESISTANT' } }));
    expect(second.ok && second.world.epoch).toBe(2);
  });

  it('is idempotent on a duplicate eventId: same world reference back, epoch unchanged', () => {
    const world = emptyWorld('campaign-1');
    const e = event({ sequence: 0, payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' } });
    const first = applyEvent(world, e);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyEvent(first.world, e);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.world).toBe(first.world); // literal reference equality — true no-op
  });

  it('rejects a sequence gap and leaves the world unchanged', () => {
    const world = emptyWorld('campaign-1');
    const gapped = event({ sequence: 5, payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' } });
    const result = applyEvent(world, gapped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('sequence-gap');
  });

  it('rejects an event for a different campaignId', () => {
    const world = emptyWorld('campaign-1');
    const wrongCampaign = event({ sequence: 0, campaignId: 'campaign-2', payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' } });
    const result = applyEvent(world, wrongCampaign);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('wrong-campaign');
  });

  it('is total for an event whose payload has no targetId/probeId — bookkeeping still applies, no graph delta', () => {
    const world = emptyWorld('campaign-1');
    const result = applyEvent(world, event({ sequence: 0, eventType: 'CampaignBudgetChanged', payload: { newBudget: 500 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.world.epoch).toBe(1);
    expect(result.world.entities.size).toBe(0);
  });

  it('merging the same PROBE_TESTS_TARGET relation twice (two attempts on the same probe) does not duplicate it', () => {
    const world = emptyWorld('campaign-1');
    const first = applyEvent(world, event({ sequence: 0, payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'RESISTANT' } }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyEvent(first.world, event({ sequence: 1, eventId: 'evt-1-retry', payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'VULNERABLE' } }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const matching = second.world.relations.filter((r) => r.type === 'PROBE_TESTS_TARGET' && r.sourceId === 'p1' && r.targetId === 't1');
    expect(matching).toHaveLength(1);
  });
});
