import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { SnapshotStore } from '../../src/world/snapshot-store.js';
import { snapshotWorld } from '../../src/world/snapshot.js';
import { emptyWorld } from '../../src/world/state.js';
import type { RecommendationBinding } from '../../src/domain/recommendation-binding.js';

describe('SnapshotStore (грань №14 — a durable home for WorldSnapshot)', () => {
  it('a saved snapshot reads back identical to what was saved', () => {
    const db = openInMemoryDatabase();
    const store = new SnapshotStore(db);
    const world = { ...emptyWorld('campaign-1'), lastSequence: 4 };
    const snapshot = snapshotWorld(world, { modelSnapshotRef: 'model-ref-1', worldBinding: null }, new Date('2026-08-31T00:00:00.000Z'));

    store.save(snapshot);

    expect(store.get('campaign-1')).toEqual(snapshot);
  });

  it('returns null for a campaign with no saved snapshot', () => {
    const db = openInMemoryDatabase();
    const store = new SnapshotStore(db);
    expect(store.get('never-saved')).toBeNull();
  });

  it('save() upserts — a second save for the same campaign replaces the first, not adds a row', () => {
    const db = openInMemoryDatabase();
    const store = new SnapshotStore(db);
    const worldA = { ...emptyWorld('campaign-1'), lastSequence: 1 };
    const worldB = { ...emptyWorld('campaign-1'), lastSequence: 5 };

    store.save(snapshotWorld(worldA, { modelSnapshotRef: null, worldBinding: null }));
    store.save(snapshotWorld(worldB, { modelSnapshotRef: null, worldBinding: null }));

    const rowCount = db.prepare(`SELECT COUNT(*) as n FROM world_snapshots WHERE campaign_id = 'campaign-1'`).get() as { n: number };
    expect(rowCount.n).toBe(1);
    expect(store.get('campaign-1')?.lastSequence).toBe(5);
  });

  it('keeps campaigns separate', () => {
    const db = openInMemoryDatabase();
    const store = new SnapshotStore(db);
    store.save(snapshotWorld({ ...emptyWorld('campaign-A'), lastSequence: 1 }, { modelSnapshotRef: null, worldBinding: null }));
    store.save(snapshotWorld({ ...emptyWorld('campaign-B'), lastSequence: 2 }, { modelSnapshotRef: null, worldBinding: null }));

    expect(store.get('campaign-A')?.lastSequence).toBe(1);
    expect(store.get('campaign-B')?.lastSequence).toBe(2);
  });

  it('round-trips a non-null worldBinding through the JSON column', () => {
    const db = openInMemoryDatabase();
    const store = new SnapshotStore(db);
    const binding: RecommendationBinding = {
      campaignId: 'campaign-1',
      targetId: 'target-1',
      worldGeneration: 0,
      worldEpoch: 3,
      featureSchemaVersion: '1.0.0',
      modelDigest: 'digest-1',
      policyVersion: 'policy-v1',
    };
    const world = { ...emptyWorld('campaign-1'), lastSequence: 1 };

    store.save(snapshotWorld(world, { modelSnapshotRef: 'model-ref', worldBinding: binding }));

    expect(store.get('campaign-1')?.worldBinding).toEqual(binding);
  });
});
