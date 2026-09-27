/**
 * ARCHITECTURE.md §4 Execution lifecycle / Run state:
 *   RunStep: PENDING → LEASED → RUNNING → SUCCEEDED | FAILED | CANCELLED
 * "Durable run_steps use lease_owner, lease_expires_at, attempt, idempotency_key,
 * last_error, committed_at."
 */

export type RunStepStatus = 'PENDING' | 'LEASED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/**
 * ARCH_CLAUDE_TRANSFER.md §2.5: the shape a real dispatch's opaque `payload` should
 * have — named here so a caller building one has a documented contract instead of an
 * inline anonymous object. `campaignId` lives in *both* the payload and the
 * `RunStep.campaignId` column: the column is what makes it queryable/joinable, the
 * payload keeps it self-describing for a worker that only ever sees the JSON blob.
 */
export interface RunStepPayload {
  readonly campaignId: string;
  readonly targetId: string;
  readonly probeId: string;
}

/** The identity a real dispatch's `RunStep` is about — see `RunStepStore.enqueue()`'s optional `identity` parameter. `null` for every caller that predates this (tests, law fixtures) or genuinely has none (the pre-Phase-4 planner tests `dispatch.ts`'s own doc comment names). */
export interface RunStep<TPayload = unknown> {
  readonly id: string;
  readonly assessmentRunId: string;
  readonly campaignId: string | null;
  readonly targetId: string | null;
  readonly idempotencyKey: string;
  readonly status: RunStepStatus;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attempt: number;
  /**
   * EXECUTION_SAFETY_RECOVERY.md §4.1: the monotonic fencing token, distinct from
   * `attempt` — "attempt_no не является fencing token: два workers могут локально
   * видеть одинаковый номер." Increments once per successful `lease()` claim
   * (fresh or takeover-after-expiry), same trigger as `attempt`, but this is the
   * value execution/execution-attempt-store.ts trusts for staleness fencing.
   */
  readonly leaseGeneration: number;
  readonly lastError: string | null;
  readonly payload: TPayload;
  readonly createdAt: string;
  readonly committedAt: string | null;
}

export interface EnqueueResult<TPayload = unknown> {
  readonly step: RunStep<TPayload>;
  /** True when a step with this idempotencyKey already existed and was returned as-is. */
  readonly deduped: boolean;
}
