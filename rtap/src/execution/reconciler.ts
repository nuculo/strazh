import type { ExecutionAttempt } from './types.js';
import type { ExecutionAttemptStore } from './execution-attempt-store.js';
import type { EffectReceiptStore } from './effect-receipt-store.js';
import type { ConcurrencyScheduler } from './concurrency-scheduler.js';
import type { EffectCapability } from './effect.js';
import { settleAttempt, type ReservationDisposition } from './settle.js';
import { decideRecovery, terminalReasonFor, type ReconciliationDecision } from './reconciliation.js';

export interface ReconcileInput {
  readonly executionAttemptId: string;
  readonly capability: EffectCapability;
  /** Only meaningful on a follow-up call after a prior `QUERY_EXTERNAL_RECEIPT` decision was actually acted on. */
  readonly queriedReceiptOutcome?: 'CONFIRMED' | 'ABSENT' | 'STILL_UNKNOWN';
}

export interface ReconcileResult {
  readonly decision: ReconciliationDecision;
  readonly attempt: ExecutionAttempt;
  /**
   * What happened to the attempt's scheduler barrier, or `null` when this decision
   * did not settle the attempt at all (`PROCEED_TO_NATIVE_RESULT`,
   * `QUERY_EXTERNAL_RECEIPT`) — a still-running attempt legitimately keeps holding
   * its reservation, which is a different thing from a settled one whose barrier was
   * deliberately retained.
   */
  readonly reservation: ReservationDisposition | null;
}

/**
 * §12's Recovery Reconciler: "works from durable state, not process memory." Takes
 * an interrupted (non-terminal) `ExecutionAttempt`, looks up whatever
 * `EffectReceipt` was durably recorded for it — never process memory — resolves
 * the recovery decision, and marks the *old* attempt terminal with the correct
 * reason when the decision settles its fate. It does not itself create a retry
 * attempt or run a compensation workflow: §12 explicitly leaves "retry creates a
 * new ExecutionAttempt and lease generation, or runs under the current active
 * owner per scheduler policy" to the caller — that's a scheduling decision (4.5.3),
 * not this reconciler's job. What this class guarantees is the *decision* and the
 * old attempt's own bookkeeping, both from durable rows, not from whatever a
 * crashed process happened to remember.
 *
 * The `ConcurrencyScheduler` is a required dependency rather than an optional one:
 * settling an attempt without disposing of the barrier admission acquired for it is
 * the leak this class was, until now, the largest single source of (see
 * `settle.ts`). Every recovery path that terminalizes an attempt here has to decide
 * the reservation's fate too, and making the dependency optional would make
 * "forgot to pass it" indistinguishable from "there was no barrier."
 */
export class EffectReconciler {
  constructor(
    private readonly attempts: ExecutionAttemptStore,
    private readonly receipts: EffectReceiptStore,
    private readonly scheduler: ConcurrencyScheduler,
  ) {}

  reconcile(input: ReconcileInput, now = new Date()): ReconcileResult {
    const attempt = this.attempts.get(input.executionAttemptId);
    if (!attempt) throw new Error(`ExecutionAttempt ${input.executionAttemptId} does not exist`);
    if (attempt.terminalReason !== null) {
      throw new Error(`ExecutionAttempt ${input.executionAttemptId} is already terminal (${attempt.terminalReason}) — nothing to reconcile`);
    }

    const receipt = this.receipts.getByExecutionAttempt(input.executionAttemptId);

    // Already definitively known — no capability consultation needed at all.
    if (receipt?.outcome === 'CONFIRMED') {
      return { decision: { action: 'PROCEED_TO_NATIVE_RESULT', reason: 'EffectReceipt already recorded CONFIRMED' }, attempt, reservation: null };
    }

    // §7.2/§13: absence of a receipt does not prove absence of an effect — only an
    // explicit FAILED_BEFORE_EFFECT receipt does.
    const effectStarted: boolean | null = receipt?.outcome === 'FAILED_BEFORE_EFFECT' ? false : null;

    const decision = decideRecovery({
      effectStarted,
      capability: input.capability,
      ...(input.queriedReceiptOutcome !== undefined ? { queriedReceiptOutcome: input.queriedReceiptOutcome } : {}),
    });
    const reason = terminalReasonFor(decision, effectStarted);
    if (reason === null) {
      return { decision, attempt, reservation: null };
    }
    const settled = settleAttempt(this.attempts, this.scheduler, attempt.executionAttemptId, reason, now);

    return { decision, attempt: settled.attempt, reservation: settled.reservation };
  }
}
