import type { DatabaseSync } from 'node:sqlite';

/**
 * Audit finding, P0#1: `CREATE TABLE IF NOT EXISTS` never updates an *existing*
 * table when a later change adds a column or constraint — the whole statement is
 * a no-op once the table already exists, silently leaving a real, persistent
 * database file's schema out of sync with what the current code expects. Every
 * schema change across every phase up to this one relied on that guard alone.
 *
 * This is the real fix: a versioned, ordered migration registry, each migration
 * applied inside its own transaction (SQLite DDL is fully transactional — a
 * mid-migration failure rolls back completely, not partially), tracked in a
 * `schema_migrations` table so a given migration is applied at most once per
 * database file, and refused outright if the database is already ahead of what
 * this build's code knows about (see `UnsupportedSchemaVersionError`).
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

/**
 * There is no earlier deployed instance of this database to reconcile against —
 * every phase up to this fix used `CREATE TABLE IF NOT EXISTS` inside one
 * monolithic schema string, re-executed (harmlessly, as a no-op past the first
 * table) on every `openDatabase()` call. Migration 1 is that same schema,
 * unchanged in content, just now tracked instead of blindly re-run — this is an
 * honest snapshot of "what a fresh RTAP instance gets today," not a fabricated
 * incremental history that never happened. Any future schema change is a new
 * migration appended after it, never an edit to this one.
 */
const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  assessment_run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE (assessment_run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_status ON run_steps (assessment_run_id, status);

CREATE TABLE IF NOT EXISTS campaign_events (
  event_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  assessment_run_id TEXT NOT NULL,
  feature_snapshot_ref TEXT,
  taxonomy_snapshot_ref TEXT,
  body_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE (campaign_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign ON campaign_events (campaign_id, sequence);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  assessment_run_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_run ON observations (assessment_run_id);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  severity TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_promotions (
  model_ref TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_promotion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_ref TEXT NOT NULL,
  event TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_promotion_log_model ON model_promotion_log (model_ref, at);

CREATE TABLE IF NOT EXISTS shadow_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  candidate_probe_id TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  world_generation INTEGER NOT NULL,
  world_epoch INTEGER NOT NULL,
  predicted_utility REAL NOT NULL,
  rank INTEGER NOT NULL,
  quality TEXT NOT NULL,
  signal_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_rankings_campaign ON shadow_rankings (campaign_id, target_id, created_at);

CREATE TABLE IF NOT EXISTS planner_dispatch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_run_id TEXT NOT NULL,
  run_step_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  deduped INTEGER NOT NULL,
  dispatched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_planner_dispatch_log_run ON planner_dispatch_log (assessment_run_id, arm);

CREATE TABLE IF NOT EXISTS domain_adapter_state (
  domain TEXT PRIMARY KEY,
  active_adapter_ref TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_adapter_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  from_adapter_ref TEXT,
  to_adapter_ref TEXT,
  reason TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_adapter_log_domain ON domain_adapter_log (domain, at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_tenant_id TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log (tenant_id, at);

CREATE TABLE IF NOT EXISTS execution_attempts (
  execution_attempt_id TEXT PRIMARY KEY,
  assessment_run_id TEXT NOT NULL,
  run_step_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  engine_adapter_id TEXT NOT NULL,
  engine_adapter_version TEXT NOT NULL,
  engine_request_id TEXT NOT NULL,
  effect_id TEXT,
  policy_snapshot_ref TEXT,
  target_snapshot_ref TEXT,
  interceptor_plan_generation INTEGER,
  concurrency_class TEXT NOT NULL,
  started_at TEXT NOT NULL,
  terminal_reason TEXT,
  terminated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_run_step ON execution_attempts (run_step_id, started_at);

CREATE TABLE IF NOT EXISTS execution_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_step_id TEXT NOT NULL,
  execution_attempt_id TEXT,
  native_result_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_quarantine_run_step ON execution_quarantine (run_step_id, quarantined_at);

CREATE TABLE IF NOT EXISTS effect_receipts (
  effect_id TEXT PRIMARY KEY,
  execution_attempt_id TEXT NOT NULL,
  engine_adapter_id TEXT NOT NULL,
  engine_request_id TEXT NOT NULL,
  idempotency_key TEXT,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  acknowledged_at TEXT,
  external_receipt_ref TEXT,
  reconciliation_token TEXT,
  outcome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_effect_receipts_attempt ON effect_receipts (execution_attempt_id);

CREATE TABLE IF NOT EXISTS authorization_receipts (
  authorization_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  assessment_run_id TEXT NOT NULL,
  run_step_id TEXT NOT NULL,
  operation_family TEXT NOT NULL,
  target_snapshot_ref TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  adapter_capability_digest TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  sandbox_profile_ref TEXT,
  egress_policy_ref TEXT,
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authorization_receipts_run_step ON authorization_receipts (run_step_id);

CREATE TABLE IF NOT EXISTS concurrency_reservations (
  reservation_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  concurrency_class TEXT NOT NULL,
  resource_keys TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  released_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_concurrency_reservations_active ON concurrency_reservations (released_at);
`;

/**
 * Audit finding #4: "outbox is mentioned in comments, but no separate outbox
 * table/publisher exists." `outbox` rows are inserted unconditionally by
 * `CampaignEventStore.append()` itself (`events/store.ts`) — every committed
 * event gets exactly one, in the same ambient transaction as the event insert,
 * never a separate step a caller could forget. `materialized_worlds` is the
 * persisted-cursor half: `world/materializer.ts`'s `CampaignWorldMaterializer`
 * reads undelivered outbox rows, applies them to the last persisted
 * `CampaignWorldState`, and persists the result — incremental, restart-safe,
 * distinct from `world/replay.ts`'s full from-scratch reconstruction, which is
 * unchanged and still exists for the cases that genuinely need it (verification,
 * `as-of-a-past-sequence` reconstruction).
 *
 * This is the first migration added after `initial_schema` — the real exercise
 * of the migration system this fix built, not a synthetic test case.
 */
const OUTBOX_AND_MATERIALIZER_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_campaign_sequence ON outbox (campaign_id, sequence);
CREATE INDEX IF NOT EXISTS idx_outbox_undelivered ON outbox (campaign_id, delivered_at);

CREATE TABLE IF NOT EXISTS materialized_worlds (
  campaign_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * ARCH_CLAUDE_TRANSFER.md §2.5: "join сегодня физически не написать" — neither
 * `run_steps` nor `execution_attempts` carried `campaign_id`/`target_id`, so nothing
 * could join a durable `ExecutionAttempt`/`TerminalReason` back to the campaign/target
 * it was about. Both columns are nullable: every existing caller (tests, law
 * fixtures, anything that predates this migration) keeps working with them simply
 * NULL — only `planner/dispatch.ts`'s real dispatch path populates them for real,
 * via `RunStepStore.enqueue()`'s new optional `identity` parameter and
 * `ExecutionAttemptStore.start()` copying it onward, the same way `start()` already
 * copies `leaseGeneration`/`attemptNo` from the RunStep without either being passed
 * explicitly by the caller.
 */
const CAMPAIGN_TARGET_IDENTITY_SQL = `
ALTER TABLE run_steps ADD COLUMN campaign_id TEXT;
ALTER TABLE run_steps ADD COLUMN target_id TEXT;
ALTER TABLE execution_attempts ADD COLUMN campaign_id TEXT;
ALTER TABLE execution_attempts ADD COLUMN target_id TEXT;

CREATE INDEX IF NOT EXISTS idx_run_steps_campaign_target ON run_steps (campaign_id, target_id);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_campaign_target ON execution_attempts (campaign_id, target_id);
`;

/**
 * грань №14 (`Грани Arch_claude`) — identity manifest instead of a pure watermark.
 * `world/snapshot.ts`'s `WorldSnapshot`/`snapshotWorld()`/`verifySnapshot()` existed
 * already, proven correct by `redteam.world/snapshot-digest-detects-tampering`, but
 * had nowhere durable to live — this is that home. One row per campaign, upserted,
 * matching `materialized_worlds`'s own "latest state only" convention exactly; no
 * historical retention, since nothing has asked for one and `replay()` can always
 * reconstruct any point from the canonical event log regardless.
 */
const WORLD_SNAPSHOTS_SQL = `
CREATE TABLE IF NOT EXISTS world_snapshots (
  campaign_id TEXT PRIMARY KEY,
  format_version TEXT NOT NULL,
  generation INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  model_snapshot_ref TEXT,
  world_binding TEXT,
  taken_at TEXT NOT NULL,
  digest TEXT NOT NULL
);
`;

/**
 * грань №12 (`Грани Arch_claude`): "ask" adapted to RTAP's own architecture, not the
 * original in-memory suspended-Promise idea — a durable record, matching how
 * CONCURRENCY back-pressure already leaves a RunStep re-leasable rather than blocking
 * anything in-process. `run_step_id UNIQUE` makes `requestApproval()` idempotent: a
 * retried, still-pending dispatch never creates a second ask for the same step.
 */
const PENDING_APPROVALS_SQL = `
CREATE TABLE IF NOT EXISTS pending_approvals (
  approval_id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  assessment_run_id TEXT NOT NULL,
  operation_family TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_undecided ON pending_approvals (decision);
`;

/**
 * грань №18: key rotation and revocation for the model-signing authority (грань
 * №16). One row per `keyId` ever registered — never per issuer, since the
 * signature string itself (`local-ed25519:<keyId>:<sig>`) only ever carries a
 * keyId, not an issuer; `issuer` here is descriptive metadata, not part of the
 * lookup key. No separate "superseded"/"retired" state: rotation is just
 * registering a new keyId — an old one is never marked, it simply keeps existing,
 * still resolvable, still trusted, until explicitly revoked. Same
 * single-row-with-lifecycle-columns shape `pending_approvals` above already
 * uses (`decision`/`decided_by`/`decided_at`), not a separate append-only log —
 * a key has at most one lifecycle event worth recording after registration
 * (revocation), not a repeating stream of attempts the way `model_promotion_log`
 * has.
 */
const SIGNING_KEYS_SQL = `
CREATE TABLE IF NOT EXISTS signing_keys (
  key_id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,
  public_key_secret_ref TEXT NOT NULL,
  issuer TEXT,
  registered_at TEXT NOT NULL,
  registered_by TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  revoked_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_signing_keys_revoked ON signing_keys (revoked_at);
`;

/**
 * грань №20: `assessment_run_id` sits as an unowned key on seven tables (run_steps,
 * campaign_events, observations, planner_dispatch_log, execution_attempts,
 * authorization_receipts, pending_approvals) with no owning row anywhere.
 * ARCH_CLAUDE_TRANSFER.md §2.4 step 4 names the gap and the shape:
 * `assessment_runs (assessment_run_id PK, campaign_id, intelligence_status DEFAULT
 * 'HEALTHY', coverage_acceptance, accepted_by, accepted_at)`.
 *
 * `intelligence_status_updated_at`/`started_at` follow this codebase's own
 * lifecycle-table idiom (`run_steps.created_at`, `pending_approvals.requested_at`,
 * `signing_keys.registered_at`) — every other such table records when its row and
 * its current state came to be.
 *
 * `ever_degraded_at` is not in the architecture doc's literal column list —
 * `intelligence_status` itself is deliberately non-monotonic
 * (`AssessmentRunStore.recordIntelligenceStatus()` overwrites it on every
 * `runPlannerOnce()` call, matching FROZEN_INTEGRATION.md's own framing of worker
 * unavailability as transient: "после восстановления worker выполняет replay"), so
 * a run that degrades once and recovers reads as clean HEALTHY afterward with
 * nothing to show it ever happened. This column is the honest fix for that: a
 * timestamp set once, on the first transition into DEGRADED, never cleared —
 * `signing_keys.revoked_at`'s "nullable timestamp doubles as a permanent flag"
 * idiom, applied to an audit fact instead of the live status field itself.
 *
 * No FOREIGN KEY constraints: none of the seven referencing tables above has ever
 * declared one (`PRAGMA foreign_keys = ON` in `db/connection.ts` notwithstanding),
 * and retrofitting enforcement here would break every existing direct insert into
 * those tables that predates an assessment_runs row.
 */
const ASSESSMENT_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS assessment_runs (
  assessment_run_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  intelligence_status TEXT NOT NULL DEFAULT 'HEALTHY',
  intelligence_status_updated_at TEXT NOT NULL,
  ever_degraded_at TEXT,
  started_at TEXT NOT NULL,
  coverage_acceptance TEXT,
  accepted_by TEXT,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assessment_runs_campaign ON assessment_runs (campaign_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    up: (db) => db.exec(INITIAL_SCHEMA_SQL),
  },
  {
    id: 2,
    name: 'outbox_and_materializer',
    up: (db) => db.exec(OUTBOX_AND_MATERIALIZER_SQL),
  },
  {
    id: 3,
    name: 'campaign_target_identity',
    up: (db) => db.exec(CAMPAIGN_TARGET_IDENTITY_SQL),
  },
  {
    id: 4,
    name: 'world_snapshots',
    up: (db) => db.exec(WORLD_SNAPSHOTS_SQL),
  },
  {
    id: 5,
    name: 'pending_approvals',
    up: (db) => db.exec(PENDING_APPROVALS_SQL),
  },
  {
    id: 6,
    name: 'signing_keys',
    up: (db) => db.exec(SIGNING_KEYS_SQL),
  },
  {
    id: 7,
    name: 'assessment_runs',
    up: (db) => db.exec(ASSESSMENT_RUNS_SQL),
  },
];

const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export class UnsupportedSchemaVersionError extends Error {
  constructor(foundId: number, knownMaxId: number) {
    super(
      `Database has migration ${foundId} applied, but this build only knows migrations up to ${knownMaxId}. ` +
        'Refusing to open — running older code against a database a newer version already migrated risks silent corruption.',
    );
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export interface AppliedMigration {
  readonly id: number;
  readonly name: string;
  readonly appliedAt: string;
}

/**
 * Applies every migration in `migrations` not yet recorded in
 * `schema_migrations`, in ascending `id` order regardless of the order they were
 * supplied in — each inside its own transaction. A migration that throws is
 * rolled back in full (SQLite DDL is transactional, so a table created earlier
 * in the same migration's `up()` is rolled back too, not left half-applied) and
 * is never recorded, so the next call retries it from scratch rather than
 * silently treating a failed migration as done.
 *
 * Fails closed on a database that is *ahead* of this build: if
 * `schema_migrations` already contains an id beyond what `migrations` defines,
 * that means a newer version of this code already touched this database file —
 * refusing to proceed is the startup-refusal half of the fix; guessing at an
 * unknown schema shape is exactly the silent-corruption risk this exists to
 * prevent. That check runs before any migration is applied, not interleaved with
 * them, so a downgrade is refused atomically, not partially.
 */
export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, now: () => Date = () => new Date()): void {
  db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);

  const appliedIds = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
  const knownMaxId = migrations.reduce((max, m) => Math.max(max, m.id), 0);
  const appliedMaxId = appliedIds.size > 0 ? Math.max(...appliedIds) : 0;
  if (appliedMaxId > knownMaxId) {
    throw new UnsupportedSchemaVersionError(appliedMaxId, knownMaxId);
  }

  const ordered = [...migrations].sort((a, b) => a.id - b.id);
  for (const migration of ordered) {
    if (appliedIds.has(migration.id)) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @appliedAt)').run({
        id: migration.id,
        name: migration.name,
        appliedAt: now().toISOString(),
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function listAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  const rows = db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC').all() as { id: number; name: string; applied_at: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, appliedAt: r.applied_at }));
}
