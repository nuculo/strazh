import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { RunStepStore } from '../runsteps/store.js';
import type {
  BindResult,
  ExecutionAttempt,
  FencingRejectionReason,
  NativeResultBinding,
  QuarantineEntry,
  StartAttemptInput,
  TerminalReason,
} from './types.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §4.5.1 — Identity and fencing. SQLite-backed,
 * layered on top of the existing `RunStepStore` rather than duplicating its lease
 * bookkeeping: an attempt's `leaseGeneration` is read from the RunStep at `start()`
 * time and never touched again, so `bindNativeResult()` can always tell whether an
 * attempt is still current by comparing against the RunStep's *live*
 * `leaseGeneration` — no separate "supersede the old attempt" step is needed when a
 * lease is taken over; the old attempt just stops matching.
 *
 * `attemptNo` is copied from `RunStep.attempt` at start time, matching §4.1's
 * explicit statement that `attempt_no` is informational, not the fencing token —
 * `leaseGeneration` is.
 */
export class ExecutionAttemptStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly runSteps: RunStepStore,
  ) {}

  start(input: StartAttemptInput, now = new Date(), executionAttemptId: string = randomUUID()): ExecutionAttempt {
    const step = this.runSteps.get(input.runStepId);
    if (!step) throw new Error(`RunStep ${input.runStepId} does not exist`);

    const attempt: ExecutionAttempt = {
      executionAttemptId,
      assessmentRunId: input.assessmentRunId,
      campaignId: step.campaignId,
      targetId: step.targetId,
      runStepId: input.runStepId,
      leaseGeneration: step.leaseGeneration,
      attemptNo: step.attempt,
      engineAdapterId: input.engineAdapterId,
      engineAdapterVersion: input.engineAdapterVersion,
      engineRequestId: input.engineRequestId,
      effectId: null,
      policySnapshotRef: input.policySnapshotRef ?? null,
      targetSnapshotRef: input.targetSnapshotRef ?? null,
      interceptorPlanGeneration: input.interceptorPlanGeneration ?? null,
      concurrencyClass: input.concurrencyClass ?? 'UNKNOWN',
      startedAt: now.toISOString(),
      terminalReason: null,
      terminatedAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO execution_attempts
           (execution_attempt_id, assessment_run_id, campaign_id, target_id, run_step_id, lease_generation, attempt_no,
            engine_adapter_id, engine_adapter_version, engine_request_id, effect_id,
            policy_snapshot_ref, target_snapshot_ref, interceptor_plan_generation,
            concurrency_class, started_at, terminal_reason, terminated_at)
         VALUES
           (@executionAttemptId, @assessmentRunId, @campaignId, @targetId, @runStepId, @leaseGeneration, @attemptNo,
            @engineAdapterId, @engineAdapterVersion, @engineRequestId, NULL,
            @policySnapshotRef, @targetSnapshotRef, @interceptorPlanGeneration,
            @concurrencyClass, @startedAt, NULL, NULL)`,
      )
      .run({
        executionAttemptId: attempt.executionAttemptId,
        assessmentRunId: attempt.assessmentRunId,
        campaignId: attempt.campaignId,
        targetId: attempt.targetId,
        runStepId: attempt.runStepId,
        leaseGeneration: attempt.leaseGeneration,
        attemptNo: attempt.attemptNo,
        engineAdapterId: attempt.engineAdapterId,
        engineAdapterVersion: attempt.engineAdapterVersion,
        engineRequestId: attempt.engineRequestId,
        policySnapshotRef: attempt.policySnapshotRef,
        targetSnapshotRef: attempt.targetSnapshotRef,
        interceptorPlanGeneration: attempt.interceptorPlanGeneration,
        concurrencyClass: attempt.concurrencyClass,
        startedAt: attempt.startedAt,
      });

    return attempt;
  }

  get(executionAttemptId: string): ExecutionAttempt | null {
    const row = this.db.prepare(`SELECT * FROM execution_attempts WHERE execution_attempt_id = @executionAttemptId`).get({ executionAttemptId }) as
      | ExecutionAttemptRow
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  listByRunStep(runStepId: string): ExecutionAttempt[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_attempts WHERE run_step_id = @runStepId ORDER BY started_at ASC`)
      .all({ runStepId }) as unknown as ExecutionAttemptRow[];
    return rows.map(rowToAttempt);
  }

  /** ARCH_CLAUDE_TRANSFER.md §2.5 — every attempt (terminal or not) recorded against a campaign, real or NULL. The bulk read `features/history-view.ts`'s `buildSettledAttemptsByReason()` composes over; callers filter to `terminalReason !== null` themselves, since "every attempt" and "every settled attempt" are different, useful queries. */
  listByCampaign(campaignId: string): ExecutionAttempt[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_attempts WHERE campaign_id = @campaignId ORDER BY started_at ASC`)
      .all({ campaignId }) as unknown as ExecutionAttemptRow[];
    return rows.map(rowToAttempt);
  }

  /** "Attempt immutable after terminal" — a second call on an already-terminal attempt is rejected, not silently overwritten. */
  markTerminal(executionAttemptId: string, reason: TerminalReason, now = new Date()): ExecutionAttempt {
    const current = this.get(executionAttemptId);
    if (!current) throw new Error(`ExecutionAttempt ${executionAttemptId} does not exist`);
    if (current.terminalReason !== null) {
      throw new Error(`ExecutionAttempt ${executionAttemptId} is already terminal (${current.terminalReason}) — attempts are immutable once terminal`);
    }
    const terminatedAt = now.toISOString();
    this.db
      .prepare(`UPDATE execution_attempts SET terminal_reason = @reason, terminated_at = @terminatedAt WHERE execution_attempt_id = @executionAttemptId`)
      .run({ executionAttemptId, reason, terminatedAt });
    const updated = this.get(executionAttemptId);
    if (!updated) throw new Error(`ExecutionAttempt ${executionAttemptId} vanished during markTerminal`);
    return updated;
  }

  /**
   * §7.2's fencing algorithm, points 1–5. Every rejection writes a quarantine
   * record before returning — "violation of points 2–5 creates a diagnostic/audit
   * record, but not a canonical Observation" is not a separate step a caller can
   * forget to do, it's this method's own side effect on the reject path.
   */
  bindNativeResult(binding: NativeResultBinding, now = new Date()): BindResult {
    const step = this.runSteps.get(binding.runStepId);
    if (!step) return this.reject(binding, 'RUN_STEP_NOT_FOUND', now);

    const attempt = this.get(binding.executionAttemptId);
    if (!attempt) return this.reject(binding, 'ATTEMPT_NOT_FOUND', now);
    if (attempt.runStepId !== binding.runStepId) return this.reject(binding, 'ATTEMPT_BELONGS_TO_DIFFERENT_STEP', now);
    if (attempt.terminalReason !== null) return this.reject(binding, 'ATTEMPT_ALREADY_TERMINAL', now);
    if (attempt.leaseGeneration !== step.leaseGeneration) return this.reject(binding, 'STALE_LEASE_RESULT', now);

    return { permitted: true };
  }

  quarantineHistory(runStepId: string): QuarantineEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_quarantine WHERE run_step_id = @runStepId ORDER BY quarantined_at ASC, id ASC`)
      .all({ runStepId }) as unknown as QuarantineRow[];
    return rows.map((r) => ({
      runStepId: r.run_step_id,
      executionAttemptId: r.execution_attempt_id,
      nativeResultRef: r.native_result_ref,
      reason: r.reason as FencingRejectionReason,
      quarantinedAt: r.quarantined_at,
    }));
  }

  private reject(binding: NativeResultBinding, reason: FencingRejectionReason, now: Date): BindResult {
    this.db
      .prepare(
        `INSERT INTO execution_quarantine (run_step_id, execution_attempt_id, native_result_ref, reason, quarantined_at)
         VALUES (@runStepId, @executionAttemptId, @nativeResultRef, @reason, @quarantinedAt)`,
      )
      .run({
        runStepId: binding.runStepId,
        executionAttemptId: binding.executionAttemptId,
        nativeResultRef: binding.nativeResultRef,
        reason,
        quarantinedAt: now.toISOString(),
      });
    return { permitted: false, reason };
  }
}

interface ExecutionAttemptRow {
  execution_attempt_id: string;
  assessment_run_id: string;
  campaign_id: string | null;
  target_id: string | null;
  run_step_id: string;
  lease_generation: number;
  attempt_no: number;
  engine_adapter_id: string;
  engine_adapter_version: string;
  engine_request_id: string;
  effect_id: string | null;
  policy_snapshot_ref: string | null;
  target_snapshot_ref: string | null;
  interceptor_plan_generation: number | null;
  concurrency_class: string;
  started_at: string;
  terminal_reason: string | null;
  terminated_at: string | null;
}

interface QuarantineRow {
  id: number;
  run_step_id: string;
  execution_attempt_id: string | null;
  native_result_ref: string;
  reason: string;
  quarantined_at: string;
}

function rowToAttempt(row: ExecutionAttemptRow): ExecutionAttempt {
  return {
    executionAttemptId: row.execution_attempt_id,
    assessmentRunId: row.assessment_run_id,
    campaignId: row.campaign_id,
    targetId: row.target_id,
    runStepId: row.run_step_id,
    leaseGeneration: row.lease_generation,
    attemptNo: row.attempt_no,
    engineAdapterId: row.engine_adapter_id,
    engineAdapterVersion: row.engine_adapter_version,
    engineRequestId: row.engine_request_id,
    effectId: row.effect_id,
    policySnapshotRef: row.policy_snapshot_ref,
    targetSnapshotRef: row.target_snapshot_ref,
    interceptorPlanGeneration: row.interceptor_plan_generation,
    concurrencyClass: row.concurrency_class as ExecutionAttempt['concurrencyClass'],
    startedAt: row.started_at,
    terminalReason: row.terminal_reason as TerminalReason | null,
    terminatedAt: row.terminated_at,
  };
}
