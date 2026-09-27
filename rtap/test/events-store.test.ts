import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../src/db/connection.js';
import { CampaignEventStore, type CampaignEventInput } from '../src/events/store.js';

function baseEvent(overrides: Partial<CampaignEventInput> = {}): CampaignEventInput {
  return {
    schemaVersion: '1.0.0',
    eventId: 'evt-1',
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    eventType: 'ProbeExecuted',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: {},
    ...overrides,
  };
}

describe('CampaignEventStore', () => {
  it('appends an event and assigns sequence 0 for a new campaign', () => {
    const store = new CampaignEventStore(openInMemoryDatabase());
    const { event, deduped } = store.append(baseEvent());
    expect(deduped).toBe(false);
    expect(event.sequence).toBe(0);
    expect(event.committedAt).toBeTruthy();
  });

  it('assigns monotonically increasing sequence per campaign', () => {
    const store = new CampaignEventStore(openInMemoryDatabase());
    store.append(baseEvent({ eventId: 'evt-1' }));
    const { event: e2 } = store.append(baseEvent({ eventId: 'evt-2' }));
    const { event: e3 } = store.append(baseEvent({ eventId: 'evt-3' }));
    expect(e2.sequence).toBe(1);
    expect(e3.sequence).toBe(2);
  });

  it('keeps separate sequences per campaign', () => {
    const store = new CampaignEventStore(openInMemoryDatabase());
    store.append(baseEvent({ eventId: 'a1', campaignId: 'campaign-A' }));
    const { event } = store.append(baseEvent({ eventId: 'b1', campaignId: 'campaign-B' }));
    expect(event.sequence).toBe(0);
  });

  it('duplicate eventId is idempotent: does not advance sequence or duplicate', () => {
    const store = new CampaignEventStore(openInMemoryDatabase());
    const first = store.append(baseEvent({ eventId: 'evt-1' }));
    store.append(baseEvent({ eventId: 'evt-2' }));
    const dup = store.append(baseEvent({ eventId: 'evt-1' }));

    expect(dup.deduped).toBe(true);
    expect(dup.event.sequence).toBe(first.event.sequence);
    expect(store.listByCampaign('campaign-1')).toHaveLength(2);
  });

  it('refuses an event that does not validate against the schema', () => {
    const store = new CampaignEventStore(openInMemoryDatabase());
    expect(() => store.append({ ...baseEvent(), eventType: 'NotARealEventType' })).toThrow();
  });

  it('lists events for a campaign in sequence order', () => {
    const store = new CampaignEventStore(openInMemoryDatabase());
    store.append(baseEvent({ eventId: 'evt-3' }));
    store.append(baseEvent({ eventId: 'evt-1' }));
    store.append(baseEvent({ eventId: 'evt-2' }));
    const listed = store.listByCampaign('campaign-1').map((e) => e.eventId);
    // insertion order, not eventId order — sequence reflects commit order.
    expect(listed).toEqual(['evt-3', 'evt-1', 'evt-2']);
  });
});
