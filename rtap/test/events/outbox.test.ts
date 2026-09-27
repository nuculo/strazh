import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { CampaignEventStore, type CampaignEventInput } from '../../src/events/store.js';
import { OutboxStore } from '../../src/events/outbox.js';

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

describe('OutboxStore', () => {
  it('CampaignEventStore.append() gives every committed event exactly one undelivered outbox row', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const outbox = new OutboxStore(db);

    events.append(baseEvent({ eventId: 'evt-1' }));
    events.append(baseEvent({ eventId: 'evt-2' }));

    const undelivered = outbox.listUndelivered('campaign-1');
    expect(undelivered).toHaveLength(2);
    expect(undelivered.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(undelivered.every((e) => e.deliveredAt === null)).toBe(true);
  });

  it('a deduped append (already-committed eventId) does not create a second outbox row', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const outbox = new OutboxStore(db);

    events.append(baseEvent({ eventId: 'evt-1' }));
    events.append(baseEvent({ eventId: 'evt-1' })); // deduped, no-op

    expect(outbox.listAll('campaign-1')).toHaveLength(1);
  });

  it('markDelivered() marks exactly the given eventIds and leaves the rest undelivered', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const outbox = new OutboxStore(db);
    events.append(baseEvent({ eventId: 'evt-1' }));
    events.append(baseEvent({ eventId: 'evt-2' }));
    events.append(baseEvent({ eventId: 'evt-3' }));

    outbox.markDelivered(['evt-1', 'evt-3']);

    const undelivered = outbox.listUndelivered('campaign-1');
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]!.eventId).toBe('evt-2');

    const all = outbox.listAll('campaign-1');
    expect(all.find((e) => e.eventId === 'evt-1')?.deliveredAt).toBeTruthy();
    expect(all.find((e) => e.eventId === 'evt-3')?.deliveredAt).toBeTruthy();
  });

  it('markDelivered() is idempotent — marking an already-delivered eventId again does not throw or change its deliveredAt', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const outbox = new OutboxStore(db);
    events.append(baseEvent({ eventId: 'evt-1' }));

    outbox.markDelivered(['evt-1'], new Date('2026-08-30T00:00:00.000Z'));
    const firstDeliveredAt = outbox.listAll('campaign-1')[0]!.deliveredAt;

    outbox.markDelivered(['evt-1'], new Date('2026-08-30T01:00:00.000Z'));
    expect(outbox.listAll('campaign-1')[0]!.deliveredAt).toBe(firstDeliveredAt);
  });

  it('markDelivered() on an empty list and on an unknown eventId are both safe no-ops', () => {
    const db = openInMemoryDatabase();
    const outbox = new OutboxStore(db);
    expect(() => outbox.markDelivered([])).not.toThrow();
    expect(() => outbox.markDelivered(['does-not-exist'])).not.toThrow();
  });

  it('keeps campaigns separate', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const outbox = new OutboxStore(db);
    events.append(baseEvent({ eventId: 'a1', campaignId: 'campaign-A' }));
    events.append(baseEvent({ eventId: 'b1', campaignId: 'campaign-B' }));

    expect(outbox.listUndelivered('campaign-A')).toHaveLength(1);
    expect(outbox.listUndelivered('campaign-B')).toHaveLength(1);
  });

  describe('pruneDelivered (ARCH_CLAUDE_TRANSFER.md §2.6)', () => {
    it('removes exactly the delivered rows at or before the watermark, and returns the count removed', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(baseEvent({ eventId: 'evt-1' }));
      events.append(baseEvent({ eventId: 'evt-2' }));
      events.append(baseEvent({ eventId: 'evt-3' }));
      outbox.markDelivered(['evt-1', 'evt-2', 'evt-3']);

      const removed = outbox.pruneDelivered('campaign-1', 1); // sequences 0 and 1 (evt-1, evt-2)
      expect(removed).toBe(2);
      expect(outbox.listAll('campaign-1').map((e) => e.eventId)).toEqual(['evt-3']);
    });

    it('never removes an undelivered row, regardless of watermark', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(baseEvent({ eventId: 'evt-1' })); // left undelivered

      const removed = outbox.pruneDelivered('campaign-1', 100);
      expect(removed).toBe(0);
      expect(outbox.listAll('campaign-1')).toHaveLength(1);
    });

    it('leaves a delivered row past the watermark untouched', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(baseEvent({ eventId: 'evt-1' }));
      events.append(baseEvent({ eventId: 'evt-2' }));
      outbox.markDelivered(['evt-1', 'evt-2']);

      const removed = outbox.pruneDelivered('campaign-1', 0); // only sequence 0 (evt-1)
      expect(removed).toBe(1);
      expect(outbox.listAll('campaign-1').map((e) => e.eventId)).toEqual(['evt-2']);
    });

    it('scopes to the given campaign only', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(baseEvent({ eventId: 'a1', campaignId: 'campaign-A' }));
      events.append(baseEvent({ eventId: 'b1', campaignId: 'campaign-B' }));
      outbox.markDelivered(['a1', 'b1']);

      outbox.pruneDelivered('campaign-A', 100);
      expect(outbox.listAll('campaign-A')).toHaveLength(0);
      expect(outbox.listAll('campaign-B')).toHaveLength(1);
    });

    it('is safe to call on an empty or already-pruned outbox', () => {
      const db = openInMemoryDatabase();
      const outbox = new OutboxStore(db);
      expect(outbox.pruneDelivered('campaign-1', 100)).toBe(0);
    });
  });
});
