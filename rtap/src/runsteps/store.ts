import type { DatabaseSync } from 'node:sqlite';
import type { EnqueueResult, RunStep, RunStepStatus } from './types.js';

export interface LeaseOptions {
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly now?: () => Date;
  /**
   * грань №19: claim exactly this step, not whichever is oldest — the counterpart to
   * `peekLeasable()`, so a caller that already picked a candidate via a concurrency
   * precheck leases the row it actually checked, not a fresh pick that could differ
   * under contention. Omitted, `lease()` behaves exactly as before.
   */
  readonly stepId?: string;
}

/** ARCH_CLAUDE_TRANSFER.md §2.5 — what a real dispatch supplies to populate `run_steps.campaign_id`/`target_id`. Optional on `enqueue()`: every caller that predates this (tests, law fixtures) has none, and the columns stay NULL for them. */
export interface RunStepIdentity {
  readonly campaignId: string;
  readonly targetId: string;
}

/**
 * Durable RunStep queue, SQLite-backed. One row per (assessmentRunId, idempotencyKey) —
 * re-enqueuing the same key returns the existing row rather than creating a duplicate,
 * which is the concrete mechanism behind redteam.run/committed-step-is-idempotent.
 *
 * Leasing is safe under node:sqlite's single-connection, synchronous execution model:
 * `lease()` does its SELECT-then-UPDATE inside one exclusive transaction, so two
 * concurrent callers in the same process cannot both lease the same step. This does not
 * extend to multiple processes/machines sharing one SQLite file — that needs the
 * PostgreSQL production profile (ARCHITECTURE.md §9 Phase 7), same interface.
 */
export class RunStepStore {
  constructor(private readonly db: DatabaseSync) {}

  enqueue<TPayload>(assessmentRunId: string, idempotencyKey: string, payload: TPayload, now = new Date(), identity?: RunStepIdentity): EnqueueResult<TPayload> {
    const existing = this.findByIdempotencyKey<TPayload>(assessmentRunId, idempotencyKey);
    if (existing) {
      return { step: existing, deduped: true };
    }

    const id = `step-${assessmentRunId}-${idempotencyKey}`;
    const createdAt = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO run_steps (id, assessment_run_id, campaign_id, target_id, idempotency_key, status, lease_owner, lease_expires_at, attempt, lease_generation, last_error, payload, created_at, committed_at)
         VALUES (@id, @assessmentRunId, @campaignId, @targetId, @idempotencyKey, 'PENDING', NULL, NULL, 0, 0, NULL, @payload, @createdAt, NULL)`,
      )
      .run({
        id,
        assessmentRunId,
        campaignId: identity?.campaignId ?? null,
        targetId: identity?.targetId ?? null,
        idempotencyKey,
        payload: JSON.stringify(payload),
        createdAt,
      });

    const step = this.get<TPayload>(id);
    if (!step) throw new Error(`RunStep ${id} vanished immediately after insert`);
    return { step, deduped: false };
  }

  /**
   * Atomically claims one PENDING step (or a LEASED/RUNNING step whose lease has
   * expired) for `owner`, or returns null if there is nothing to claim. Increments
   * `attempt` on every successful claim, including retries of an expired lease.
   * `options.stepId`, if given, restricts the claim to that specific step — still
   * subject to the same PENDING-or-expired predicate, so a step taken by a racing
   * lease() between a caller's peekLeasable() and this call correctly yields null
   * rather than claiming a stale view of it.
   */
  lease<TPayload>(assessmentRunId: string, options: LeaseOptions): RunStep<TPayload> | null {
    const now = (options.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + options.leaseDurationMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = this.findLeaseCandidate(assessmentRunId, nowIso, options.stepId ? { stepId: options.stepId } : undefined);

      if (!candidate) {
        this.db.exec('COMMIT');
        return null;
      }

      this.db
        .prepare(
          `UPDATE run_steps
           SET status = 'LEASED', lease_owner = @owner, lease_expires_at = @expiresAt, attempt = attempt + 1, lease_generation = lease_generation + 1, last_error = NULL
           WHERE id = @id`,
        )
        .run({ id: candidate.id, owner: options.owner, expiresAt });

      this.db.exec('COMMIT');
      return this.get<TPayload>(candidate.id);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * грань №19 — a non-mutating look-ahead at what `lease()` would claim next, sharing
   * `findLeaseCandidate()`'s exact predicate so the two cannot structurally disagree
   * about what counts as leasable. Lets a caller (a worker's drain loop) decide
   * whether a candidate is even worth leasing — e.g. a concurrency precheck — before
   * paying the real lease's `lease_generation` bump, which is the fencing token a
   * genuinely in-flight prior attempt depends on.
   *
   * `excludeIds` skips candidates already examined and rejected earlier in the same
   * scan (e.g. found concurrency-blocked), so repeated peeks within one drain pass
   * advance through the queue instead of returning the same oldest-but-rejected row
   * forever.
   */
  peekLeasable<TPayload>(assessmentRunId: string, opts: { readonly excludeIds?: readonly string[]; readonly now?: () => Date } = {}): RunStep<TPayload> | null {
    const now = (opts.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const candidate = this.findLeaseCandidate(assessmentRunId, nowIso, opts.excludeIds && opts.excludeIds.length > 0 ? { excludeIds: opts.excludeIds } : undefined);
    return candidate ? this.get<TPayload>(candidate.id) : null;
  }

  /**
   * The one candidate-selection predicate `lease()` and `peekLeasable()` both use —
   * factored out so a peek and the real lease it precedes structurally cannot
   * disagree about what "leasable" means. `filter.stepId` narrows to one specific
   * row (for `lease()`'s targeted claim); `filter.excludeIds` skips already-examined
   * rows (for `peekLeasable()`'s repeated scan). The two are never combined by any
   * caller today, but nothing here assumes they can't be.
   */
  private findLeaseCandidate(assessmentRunId: string, nowIso: string, filter?: { readonly stepId?: string; readonly excludeIds?: readonly string[] }): { id: string } | undefined {
    const clauses: string[] = [];
    const params: Record<string, string> = { assessmentRunId, nowIso };

    if (filter?.stepId) {
      clauses.push('AND id = @stepId');
      params['stepId'] = filter.stepId;
    }
    if (filter?.excludeIds && filter.excludeIds.length > 0) {
      const placeholders = filter.excludeIds.map((_, i) => `@exclude${i}`);
      filter.excludeIds.forEach((id, i) => {
        params[`exclude${i}`] = id;
      });
      clauses.push(`AND id NOT IN (${placeholders.join(', ')})`);
    }

    return this.db
      .prepare(
        `SELECT id FROM run_steps
         WHERE assessment_run_id = @assessmentRunId
           AND (
             status = 'PENDING'
             OR (status IN ('LEASED', 'RUNNING') AND lease_expires_at IS NOT NULL AND lease_expires_at < @nowIso)
           )
           ${clauses.join('\n           ')}
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(params) as { id: string } | undefined;
  }

  markRunning(id: string, owner: string): RunStep {
    return this.transition(id, 'RUNNING', { requireStatus: 'LEASED', requireOwner: owner });
  }

  complete(id: string, owner: string, now = new Date()): RunStep {
    return this.transition(id, 'SUCCEEDED', { requireStatus: 'RUNNING', requireOwner: owner, committedAt: now.toISOString() });
  }

  fail(id: string, owner: string, error: string, now = new Date()): RunStep {
    return this.transition(id, 'FAILED', { requireOwner: owner, lastError: error, committedAt: now.toISOString() });
  }

  cancel(id: string, now = new Date()): RunStep {
    return this.transition(id, 'CANCELLED', { committedAt: now.toISOString() });
  }

  get<TPayload = unknown>(id: string): RunStep<TPayload> | null {
    const row = this.db.prepare(`SELECT * FROM run_steps WHERE id = @id`).get({ id }) as RunStepRow | undefined;
    return row ? rowToRunStep<TPayload>(row) : null;
  }

  listByAssessmentRun<TPayload = unknown>(assessmentRunId: string): RunStep<TPayload>[] {
    const rows = this.db
      .prepare(`SELECT * FROM run_steps WHERE assessment_run_id = @assessmentRunId ORDER BY created_at ASC`)
      .all({ assessmentRunId }) as unknown as RunStepRow[];
    return rows.map((r) => rowToRunStep<TPayload>(r));
  }

  private findByIdempotencyKey<TPayload>(assessmentRunId: string, idempotencyKey: string): RunStep<TPayload> | null {
    const row = this.db
      .prepare(`SELECT * FROM run_steps WHERE assessment_run_id = @assessmentRunId AND idempotency_key = @idempotencyKey`)
      .get({ assessmentRunId, idempotencyKey }) as RunStepRow | undefined;
    return row ? rowToRunStep<TPayload>(row) : null;
  }

  private transition(
    id: string,
    status: RunStepStatus,
    opts: { requireStatus?: RunStepStatus; requireOwner?: string; lastError?: string; committedAt?: string },
  ): RunStep {
    const current = this.get(id);
    if (!current) throw new Error(`RunStep ${id} does not exist`);
    if (opts.requireStatus && current.status !== opts.requireStatus) {
      throw new Error(`RunStep ${id} expected status ${opts.requireStatus}, was ${current.status}`);
    }
    if (opts.requireOwner && current.leaseOwner !== opts.requireOwner) {
      throw new Error(`RunStep ${id} is leased by ${current.leaseOwner ?? 'nobody'}, not ${opts.requireOwner}`);
    }
    this.db
      .prepare(
        `UPDATE run_steps
         SET status = @status,
             last_error = COALESCE(@lastError, last_error),
             committed_at = COALESCE(@committedAt, committed_at)
         WHERE id = @id`,
      )
      .run({ id, status, lastError: opts.lastError ?? null, committedAt: opts.committedAt ?? null });
    const updated = this.get(id);
    if (!updated) throw new Error(`RunStep ${id} vanished during transition`);
    return updated;
  }
}

interface RunStepRow {
  id: string;
  assessment_run_id: string;
  campaign_id: string | null;
  target_id: string | null;
  idempotency_key: string;
  status: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt: number;
  lease_generation: number;
  last_error: string | null;
  payload: string;
  created_at: string;
  committed_at: string | null;
}

function rowToRunStep<TPayload>(row: RunStepRow): RunStep<TPayload> {
  return {
    id: row.id,
    assessmentRunId: row.assessment_run_id,
    campaignId: row.campaign_id,
    targetId: row.target_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as RunStepStatus,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    leaseGeneration: row.lease_generation,
    lastError: row.last_error,
    payload: JSON.parse(row.payload) as TPayload,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}
