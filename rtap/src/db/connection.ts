import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations.js';

/**
 * ARCHITECTURE.md §0 passport: "Local persistence  SQLite + protected filesystem
 * artifacts". Uses Node's built-in node:sqlite (experimental as of Node 22) instead
 * of a native binding dependency — no node-gyp/prebuilt-binary risk for a Phase 1
 * skeleton. Every store above this layer takes a `DatabaseSync` by constructor
 * injection and never imports node:sqlite's connection helpers directly — that seam
 * is where a PostgreSQL production profile would attach.
 *
 * Phase 7 evaluated actually swapping to PostgreSQL here and chose not to: every
 * store above is written against `DatabaseSync`'s synchronous prepared-statement API
 * (`.prepare(sql).run/.get/.all`), and `pg`'s client is inherently async — bridging
 * the two honestly means either a sync Postgres driver (none exists for Node) or an
 * async rewrite of every store, every pipeline function, and every test in this repo,
 * which is a different, much larger change than "add a production backend." Untested
 * against a live database, a `PostgresStore` here would just be code nobody ran. What
 * Phase 7 built instead: the three ports ARCHITECTURE.md §3.4 named but nothing had
 * implemented — ArtifactStore, SecretProvider, AuthorizationProvider (see
 * src/artifacts, src/secrets, src/authz) — plus an audit log and CampaignWorld
 * snapshots. See rtap/README.md's Phase 7 section for the full account.
 *
 * The actual table/index DDL lives in `migrations.ts` now, not here — an audit
 * finding: `CREATE TABLE IF NOT EXISTS`, re-executed on every open, never updates
 * an *existing* table when a later phase adds a column, silently leaving a real
 * persistent database file's schema stale. `migrations.ts` tracks what's been
 * applied and refuses to open a database it doesn't fully understand; see its own
 * doc comment and rtap/README.md's "Bug fix: schema migrations" section.
 */

export function openDatabase(location: string): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
}

export function openInMemoryDatabase(): DatabaseSync {
  return openDatabase(':memory:');
}
