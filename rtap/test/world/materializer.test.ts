import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { CampaignEventStore, type CampaignEventInput } from '../../src/events/store.js';
import { OutboxStore } from '../../src/events/outbox.js';
import { CampaignWorldMaterializer } from '../../src/world/materializer.js';
import { replay } from '../../src/world/replay.js';
import { fingerprint } from '../../src/world/fingerprint.js';

function eventInput(sequence: number, targetId: string, probeId: string, verdict: string, overrides: Partial<CampaignEventInput> = {}): CampaignEventInput {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${sequence}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId, probeId, verdict },
    ...overrides,
  };
}

describe('CampaignWorldMaterializer', () => {
  it('current() is null before advance() has ever run for a campaign', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const materializer = new CampaignWorldMaterializer(db, events);
    expect(materializer.current('campaign-1')).toBeNull();
  });

  it('advance() applies every undelivered outbox row and persists the result', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
    events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));

    const materializer = new CampaignWorldMaterializer(db, events);
    const result = materializer.advance('campaign-1');

    expect(result.stoppedAt).toBeNull();
    expect(result.eventsApplied).toBe(2);
    expect(result.world.lastSequence).toBe(1);
    expect(materializer.current('campaign-1')?.lastSequence).toBe(1);
  });

  it('a second advance() call with no new events is a no-op that returns the same persisted world', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));

    const materializer = new CampaignWorldMaterializer(db, events);
    materializer.advance('campaign-1');
    const second = materializer.advance('campaign-1');

    expect(second.eventsApplied).toBe(0);
    expect(second.world.lastSequence).toBe(0);
  });

  it('marks every applied outbox row delivered, and leaves later, not-yet-applied rows undelivered', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
    const materializer = new CampaignWorldMaterializer(db, events);
    materializer.advance('campaign-1');

    events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));
    const undeliveredRow = db.prepare(`SELECT delivered_at FROM outbox WHERE event_id = 'evt-1'`).get() as { delivered_at: string | null };
    expect(undeliveredRow.delivered_at).toBeNull();

    const deliveredRow = db.prepare(`SELECT delivered_at FROM outbox WHERE event_id = 'evt-0'`).get() as { delivered_at: string | null };
    expect(deliveredRow.delivered_at).toBeTruthy();
  });

  it('resumes correctly across a fresh instance sharing the same database — the persisted cursor, not object state, drives resumption', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
    events.append(eventInput(1, 't2', 'p2:s1', 'RESISTANT'));

    const first = new CampaignWorldMaterializer(db, events);
    first.advance('campaign-1');

    events.append(eventInput(2, 't1', 'p3:s1', 'VULNERABLE'));

    // A brand-new instance — simulating a process restart — must pick up exactly
    // where the last persisted cursor left off, not re-derive from scratch.
    const second = new CampaignWorldMaterializer(db, events);
    const result = second.advance('campaign-1');

    expect(result.eventsApplied).toBe(1); // only the one new event, not all three again
    expect(result.world.lastSequence).toBe(2);

    const fullReplay = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;
    expect(fingerprint(result.world)).toBe(fingerprint(fullReplay));
  });

  it('a real committed event stream materializes to the same fingerprint as a full replay', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    events.append(eventInput(0, 't1', 'prompt-injection:base64', 'VULNERABLE'));
    events.append(eventInput(1, 't1', 'jailbreak:default', 'RESISTANT'));
    events.append(eventInput(2, 't2', 'prompt-injection:base64', 'UNVERIFIED'));

    const materializer = new CampaignWorldMaterializer(db, events);
    const { world } = materializer.advance('campaign-1');
    const replayed = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;

    expect(fingerprint(world)).toBe(fingerprint(replayed));
  });

  it('stops (not skips) on a sequence gap, exactly like replay(), if an outbox row is ever missing for a committed sequence', () => {
    // events/store.ts guarantees every append() writes both rows in the same
    // statement sequence, so this can only happen if that invariant is somehow
    // violated — advance() defends against it anyway rather than silently
    // skipping ahead. Simulated here by deleting just the middle outbox row,
    // leaving its campaign_events row (and therefore its sequence) intact.
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
    events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));
    events.append(eventInput(2, 't1', 'p3:s1', 'VULNERABLE'));
    db.exec(`DELETE FROM outbox WHERE event_id = 'evt-1'`);

    const materializer = new CampaignWorldMaterializer(db, events);
    const result = materializer.advance('campaign-1');

    expect(result.eventsApplied).toBe(1);
    expect(result.world.lastSequence).toBe(0);
    expect(result.stoppedAt?.error.kind).toBe('sequence-gap');
  });

  describe('pruneDeliveredOutbox (ARCH_CLAUDE_TRANSFER.md §2.6)', () => {
    it('deletes every delivered outbox row at or before the persisted cursor', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));
      const materializer = new CampaignWorldMaterializer(db, events, outbox);
      materializer.advance('campaign-1');

      const removed = materializer.pruneDeliveredOutbox('campaign-1');
      expect(removed).toBe(2);
      expect(outbox.listAll('campaign-1')).toHaveLength(0);
    });

    it('is a no-op that removes nothing when no world has been materialized yet — no watermark to prune against', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      const materializer = new CampaignWorldMaterializer(db, events, outbox);

      const removed = materializer.pruneDeliveredOutbox('campaign-1'); // advance() never called
      expect(removed).toBe(0);
      expect(outbox.listAll('campaign-1')).toHaveLength(1);
    });

    it('never removes a row past the watermark — it stays there for the next advance()', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      const materializer = new CampaignWorldMaterializer(db, events, outbox);
      materializer.advance('campaign-1');

      events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT')); // not yet materialized
      materializer.pruneDeliveredOutbox('campaign-1');

      const remaining = outbox.listAll('campaign-1');
      expect(remaining.map((e) => e.eventId)).toEqual(['evt-1']);
      expect(remaining[0]!.deliveredAt).toBeNull();
    });

    it('pruning does not disturb resumption — a later advance() still reaches the same fingerprint as a full replay', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));
      const first = new CampaignWorldMaterializer(db, events, outbox);
      first.advance('campaign-1');
      first.pruneDeliveredOutbox('campaign-1');

      events.append(eventInput(2, 't1', 'p3:s1', 'VULNERABLE'));
      const second = new CampaignWorldMaterializer(db, events, outbox);
      const result = second.advance('campaign-1');

      expect(result.eventsApplied).toBe(1); // only the new one — pruning left no phantom backlog
      const replayed = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;
      expect(fingerprint(result.world)).toBe(fingerprint(replayed));
    });
  });

  describe('snapshot verification and corruption fallback (грань №14 — ARCH_CLAUDE_TRANSFER-style identity manifest)', () => {
    it('advance() writes a snapshot alongside materialized_worlds whenever an event was actually applied', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      const materializer = new CampaignWorldMaterializer(db, events);
      materializer.advance('campaign-1');

      const row = db.prepare(`SELECT * FROM world_snapshots WHERE campaign_id = 'campaign-1'`).get() as { last_sequence: number; digest: string } | undefined;
      expect(row).toBeTruthy();
      expect(row!.last_sequence).toBe(0);
    });

    it('a no-op advance() (zero events applied) does not rewrite an already-correct snapshot', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      const materializer = new CampaignWorldMaterializer(db, events);
      materializer.advance('campaign-1');
      const firstDigest = (db.prepare(`SELECT digest, taken_at FROM world_snapshots WHERE campaign_id = 'campaign-1'`).get() as { digest: string; taken_at: string });

      materializer.advance('campaign-1'); // nothing new to apply
      const secondDigest = (db.prepare(`SELECT digest, taken_at FROM world_snapshots WHERE campaign_id = 'campaign-1'`).get() as { digest: string; taken_at: string });

      expect(secondDigest).toEqual(firstDigest); // untouched, not merely equal in value
    });

    it('current() falls back to a full replay() when state_json is not valid JSON, instead of throwing', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));
      const materializer = new CampaignWorldMaterializer(db, events);
      materializer.advance('campaign-1');

      db.prepare(`UPDATE materialized_worlds SET state_json = 'not valid json{{{' WHERE campaign_id = 'campaign-1'`).run();

      const recovered = materializer.current('campaign-1');
      expect(recovered).not.toBeNull();
      const replayed = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;
      expect(fingerprint(recovered!)).toBe(fingerprint(replayed));
    });

    it('current() falls back to a full replay() when state_json is valid JSON but disagrees with the last snapshot', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      events.append(eventInput(0, 't1', 'p1:s1', 'VULNERABLE'));
      events.append(eventInput(1, 't1', 'p2:s1', 'RESISTANT'));
      const materializer = new CampaignWorldMaterializer(db, events);
      materializer.advance('campaign-1');

      // Valid JSON, but a tampered lastSequence — the snapshot still says 1.
      const row = db.prepare(`SELECT state_json FROM materialized_worlds WHERE campaign_id = 'campaign-1'`).get() as { state_json: string };
      const tampered = { ...JSON.parse(row.state_json), lastSequence: 999 };
      db.prepare(`UPDATE materialized_worlds SET state_json = @stateJson WHERE campaign_id = 'campaign-1'`).run({ stateJson: JSON.stringify(tampered) });

      const recovered = materializer.current('campaign-1');
      expect(recovered).not.toBeNull();
      expect(recovered!.lastSequence).toBe(1); // the correct value, not the tampered 999
      const replayed = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;
      expect(fingerprint(recovered!)).toBe(fingerprint(replayed));
    });

    it('a campaign with no snapshot row yet (e.g. its first advance() applied zero events) skips verification and returns the plain deserialized world', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const materializer = new CampaignWorldMaterializer(db, events);
      materializer.advance('campaign-1'); // no events at all — materialized_worlds gets a row, world_snapshots does not

      expect(db.prepare(`SELECT * FROM world_snapshots WHERE campaign_id = 'campaign-1'`).get()).toBeUndefined();
      expect(materializer.current('campaign-1')).not.toBeNull();
    });

    it('a real committed event stream still materializes to the same fingerprint as a full replay, with snapshot verification now in the loop', () => {
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      events.append(eventInput(0, 't1', 'prompt-injection:base64', 'VULNERABLE'));
      events.append(eventInput(1, 't1', 'jailbreak:default', 'RESISTANT'));
      events.append(eventInput(2, 't2', 'prompt-injection:base64', 'UNVERIFIED'));

      const materializer = new CampaignWorldMaterializer(db, events);
      const { world } = materializer.advance('campaign-1');
      const replayed = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;

      expect(fingerprint(world)).toBe(fingerprint(replayed));
      expect(fingerprint(materializer.current('campaign-1')!)).toBe(fingerprint(replayed));
    });
  });
});
