import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, listAppliedMigrations, UnsupportedSchemaVersionError, MIGRATIONS, type Migration } from '../../src/db/migrations.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'`).all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return tableNames(db).includes(name);
}

describe('the real production migration list, applied via openDatabase()', () => {
  it('creates the expected tables and records every migration this build knows about, in order', () => {
    const db = openInMemoryDatabase();
    expect(tableExists(db, 'run_steps')).toBe(true);
    expect(tableExists(db, 'concurrency_reservations')).toBe(true);
    expect(tableExists(db, 'outbox')).toBe(true);
    expect(tableExists(db, 'materialized_worlds')).toBe(true);
    expect(tableExists(db, 'world_snapshots')).toBe(true);
    expect(tableExists(db, 'pending_approvals')).toBe(true);
    expect(tableExists(db, 'signing_keys')).toBe(true);
    expect(tableExists(db, 'assessment_runs')).toBe(true);
    expect(listAppliedMigrations(db)).toEqual([
      { id: 1, name: 'initial_schema', appliedAt: expect.any(String) },
      { id: 2, name: 'outbox_and_materializer', appliedAt: expect.any(String) },
      { id: 3, name: 'campaign_target_identity', appliedAt: expect.any(String) },
      { id: 4, name: 'world_snapshots', appliedAt: expect.any(String) },
      { id: 5, name: 'pending_approvals', appliedAt: expect.any(String) },
      { id: 6, name: 'signing_keys', appliedAt: expect.any(String) },
      { id: 7, name: 'assessment_runs', appliedAt: expect.any(String) },
    ]);
  });

  it('MIGRATIONS has no duplicate or non-positive ids', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id >= 1)).toBe(true);
  });
});

describe('applyMigrations', () => {
  it('is idempotent: calling it again on an already-migrated database applies nothing new', () => {
    const db = openInMemoryDatabase();
    const before = listAppliedMigrations(db);
    applyMigrations(db); // second call, real migration list
    expect(listAppliedMigrations(db)).toEqual(before);
  });

  it('applies migrations in ascending id order regardless of the order supplied', () => {
    const order: number[] = [];
    const migrations: Migration[] = [
      { id: 3, name: 'third', up: () => order.push(3) },
      { id: 1, name: 'first', up: () => order.push(1) },
      { id: 2, name: 'second', up: () => order.push(2) },
    ];
    applyMigrations(new DatabaseSync(':memory:'), migrations);
    expect(order).toEqual([1, 2, 3]);
  });

  it('an upgrade from N to N+1 preserves existing data and makes the new column usable — the real scenario this fix exists for', () => {
    const db = new DatabaseSync(':memory:');
    const v1: Migration[] = [
      {
        id: 1,
        name: 'create_widgets',
        up: (d) => d.exec(`CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)`),
      },
    ];
    applyMigrations(db, v1);
    db.prepare(`INSERT INTO widgets (id, name) VALUES ('w1', 'first widget')`).run();

    // "Upgrade" the running code: the same database file, now opened by code that
    // knows about migration 2 too — exactly what CREATE TABLE IF NOT EXISTS could
    // never do for an existing table.
    const v2: Migration[] = [
      ...v1,
      {
        id: 2,
        name: 'add_widgets_color',
        up: (d) => d.exec(`ALTER TABLE widgets ADD COLUMN color TEXT`),
      },
    ];
    applyMigrations(db, v2);

    // Pre-migration-2 data survived untouched.
    const existing = db.prepare(`SELECT id, name, color FROM widgets WHERE id = 'w1'`).get() as { id: string; name: string; color: string | null };
    expect(existing).toEqual({ id: 'w1', name: 'first widget', color: null });

    // The new column is genuinely usable for new rows.
    db.prepare(`INSERT INTO widgets (id, name, color) VALUES ('w2', 'second widget', 'blue')`).run();
    const fresh = db.prepare(`SELECT color FROM widgets WHERE id = 'w2'`).get() as { color: string };
    expect(fresh.color).toBe('blue');

    expect(listAppliedMigrations(db).map((m) => m.id)).toEqual([1, 2]);
  });

  it('a failing migration is rolled back in full, including work it already did before throwing, and is never recorded as applied', () => {
    const db = new DatabaseSync(':memory:');
    const failing: Migration[] = [
      {
        id: 1,
        name: 'partially_fails',
        up: (d) => {
          d.exec(`CREATE TABLE survives_rollback (id TEXT PRIMARY KEY)`);
          throw new Error('simulated mid-migration failure');
        },
      },
    ];

    expect(() => applyMigrations(db, failing)).toThrow('simulated mid-migration failure');
    expect(tableExists(db, 'survives_rollback')).toBe(false); // the whole transaction rolled back, not just the throw
    expect(listAppliedMigrations(db)).toEqual([]);

    // Retrying with a fixed version of the same migration id succeeds cleanly —
    // the failed attempt left no partial state to conflict with a retry.
    const fixed: Migration[] = [{ id: 1, name: 'fixed', up: (d) => d.exec(`CREATE TABLE survives_rollback (id TEXT PRIMARY KEY)`) }];
    applyMigrations(db, fixed);
    expect(tableExists(db, 'survives_rollback')).toBe(true);
    expect(listAppliedMigrations(db)).toEqual([{ id: 1, name: 'fixed', appliedAt: expect.any(String) }]);
  });

  it('refuses to open a database that already has a migration applied beyond what this build knows about', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, [
      { id: 1, name: 'first', up: (d) => d.exec(`CREATE TABLE t1 (id TEXT PRIMARY KEY)`) },
      { id: 2, name: 'second', up: (d) => d.exec(`CREATE TABLE t2 (id TEXT PRIMARY KEY)`) },
    ]);

    // Older code, only aware of migration 1, opens the same (already-newer) database.
    expect(() => applyMigrations(db, [{ id: 1, name: 'first', up: (d) => d.exec(`CREATE TABLE t1 (id TEXT PRIMARY KEY)`) }])).toThrow(
      UnsupportedSchemaVersionError,
    );
  });

  it('the unsupported-version refusal happens before any migration in the older list is (re-)applied', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, [
      { id: 1, name: 'first', up: (d) => d.exec(`CREATE TABLE t1 (id TEXT PRIMARY KEY)`) },
      { id: 5, name: 'future', up: (d) => d.exec(`CREATE TABLE t5 (id TEXT PRIMARY KEY)`) },
    ]);

    let sideEffectRan = false;
    const olderList: Migration[] = [
      { id: 1, name: 'first', up: () => {} },
      {
        id: 3,
        name: 'not_yet_applied_but_stale_view',
        up: (d) => {
          sideEffectRan = true;
          d.exec(`CREATE TABLE t3 (id TEXT PRIMARY KEY)`);
        },
      },
    ];
    expect(() => applyMigrations(db, olderList)).toThrow(UnsupportedSchemaVersionError);
    expect(sideEffectRan).toBe(false);
    expect(tableExists(db, 't3')).toBe(false);
  });

  it('injected `now` controls appliedAt deterministically', () => {
    const db = new DatabaseSync(':memory:');
    const fixed = new Date('2026-08-31T00:00:00.000Z');
    applyMigrations(db, [{ id: 1, name: 'first', up: (d) => d.exec(`CREATE TABLE t1 (id TEXT PRIMARY KEY)`) }], () => fixed);
    expect(listAppliedMigrations(db)[0]?.appliedAt).toBe(fixed.toISOString());
  });
});
