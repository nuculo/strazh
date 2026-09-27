import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { EffectReceiptStore } from '../../src/execution/effect-receipt-store.js';
import { EffectReconciler } from '../../src/execution/reconciler.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { settleAttempt } from '../../src/execution/settle.js';
import type { ExecutionAttempt } from '../../src/execution/types.js';

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const scheduler = new ConcurrencyScheduler(db);
  const receipts = new EffectReceiptStore(db);
  return { db, runSteps, attempts, scheduler, receipts };
}

function startAttempt(runSteps: RunStepStore, attempts: ExecutionAttemptStore, key = 'k1'): ExecutionAttempt {
  const { step } = runSteps.enqueue('run-1', key, {});
  runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
  return attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${key}` });
}

function reserveFor(scheduler: ConcurrencyScheduler, executionAttemptId: string, resourceKey = 'target-1') {
  const result = scheduler.reserve({
    campaignId: 'campaign-1',
    executionAttemptId,
    declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: [resourceKey], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
  });
  if (!result.reserved) throw new Error('test setup: reservation was unexpectedly refused');
  return result.reservation;
}

describe('settleAttempt', () => {
  it('releases the barrier for a settled attempt — the leak audit #7 left open', () => {
    const { runSteps, attempts, scheduler } = setup();
    const attempt = startAttempt(runSteps, attempts);
    const reservation = reserveFor(scheduler, attempt.executionAttemptId);

    const result = settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'FAILED_BEFORE_EFFECT');

    expect(result.attempt.terminalReason).toBe('FAILED_BEFORE_EFFECT');
    expect(result.reservation).toEqual({ kind: 'RELEASED', reservationId: reservation.reservationId });
    expect(scheduler.activeReservations()).toHaveLength(0);
  });

  it('deliberately RETAINS the barrier on UNKNOWN_EFFECT_OUTCOME — the effect may still be in flight', () => {
    const { runSteps, attempts, scheduler } = setup();
    const attempt = startAttempt(runSteps, attempts);
    const reservation = reserveFor(scheduler, attempt.executionAttemptId);

    const result = settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'UNKNOWN_EFFECT_OUTCOME');

    expect(result.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(result.reservation).toEqual({ kind: 'RETAINED', reservationId: reservation.reservationId, why: 'UNKNOWN_EFFECT_OUTCOME' });
    // Still genuinely held, not merely reported as retained.
    expect(scheduler.activeReservations()).toHaveLength(1);
    expect(scheduler.activeReservationForAttempt(attempt.executionAttemptId)).not.toBeNull();
  });

  it('a retained barrier really does keep blocking new work on the same target (RUNBOOK.md Part B is the only way out)', () => {
    const { runSteps, attempts, scheduler } = setup();
    const attempt = startAttempt(runSteps, attempts);
    reserveFor(scheduler, attempt.executionAttemptId);
    settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'UNKNOWN_EFFECT_OUTCOME');

    const contender = scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: 'some-other-attempt',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });

    expect(contender.reserved).toBe(false);
  });

  it('reports NONE, not a failure, when the attempt never held a barrier', () => {
    const { runSteps, attempts, scheduler } = setup();
    const attempt = startAttempt(runSteps, attempts);

    const result = settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'CANCELLED');

    expect(result.attempt.terminalReason).toBe('CANCELLED');
    expect(result.reservation).toEqual({ kind: 'NONE' });
  });

  it('refuses a second settlement — the barrier\'s fate cannot be re-decided after the fact', () => {
    const { runSteps, attempts, scheduler } = setup();
    const attempt = startAttempt(runSteps, attempts);
    reserveFor(scheduler, attempt.executionAttemptId);

    settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'UNKNOWN_EFFECT_OUTCOME');
    expect(() => settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'COMPLETED')).toThrow(/immutable once terminal/);
    // The retained barrier survived the refused second settlement.
    expect(scheduler.activeReservations()).toHaveLength(1);
  });

  it('releases only the settled attempt\'s own barrier, leaving other attempts\' reservations alone', () => {
    const { runSteps, attempts, scheduler } = setup();
    const mine = startAttempt(runSteps, attempts, 'k1');
    const theirs = startAttempt(runSteps, attempts, 'k2');
    reserveFor(scheduler, mine.executionAttemptId, 'target-1');
    const theirReservation = reserveFor(scheduler, theirs.executionAttemptId, 'target-2');

    settleAttempt(attempts, scheduler, mine.executionAttemptId, 'COMPLETED');

    const stillActive = scheduler.activeReservations();
    expect(stillActive).toHaveLength(1);
    expect(stillActive[0]?.reservationId).toBe(theirReservation.reservationId);
  });
});

describe('EffectReconciler releases the barrier it settles (audit #7 gap)', () => {
  it('a reconciled FAILED_BEFORE_EFFECT attempt no longer holds its reservation', () => {
    const { db, runSteps, attempts, receipts } = setup();
    const scheduler = new ConcurrencyScheduler(db);
    const reconciler = new EffectReconciler(attempts, receipts, scheduler);
    const attempt = startAttempt(runSteps, attempts);
    reserveFor(scheduler, attempt.executionAttemptId);
    receipts.record({
      effectId: 'effect-1',
      executionAttemptId: attempt.executionAttemptId,
      engineAdapterId: 'promptfoo',
      engineRequestId: 'req-1',
      idempotencyKey: 'key-1',
      capability: 'IDEMPOTENT_BY_KEY',
      startedAt: new Date(0).toISOString(),
      acknowledgedAt: null,
      externalReceiptRef: null,
      reconciliationToken: null,
      outcome: 'FAILED_BEFORE_EFFECT',
    });

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'IDEMPOTENT_BY_KEY' });

    expect(result.attempt.terminalReason).toBe('FAILED_BEFORE_EFFECT');
    expect(result.reservation?.kind).toBe('RELEASED');
    // Before this change the reconciler had no scheduler at all, so this was 1.
    expect(scheduler.activeReservations()).toHaveLength(0);
  });

  it('a reconciled UNKNOWN_EFFECT_OUTCOME attempt keeps its barrier, and says so', () => {
    const { db, runSteps, attempts, receipts } = setup();
    const scheduler = new ConcurrencyScheduler(db);
    const reconciler = new EffectReconciler(attempts, receipts, scheduler);
    const attempt = startAttempt(runSteps, attempts);
    reserveFor(scheduler, attempt.executionAttemptId);

    // No receipt at all + AT_MOST_ONCE_UNPROVEN — the one case that must never be retried.
    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' });

    expect(result.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(result.reservation).toMatchObject({ kind: 'RETAINED', why: 'UNKNOWN_EFFECT_OUTCOME' });
    expect(scheduler.activeReservations()).toHaveLength(1);
  });

  it('a decision that does not settle the attempt reports no disposition and leaves the barrier held', () => {
    const { db, runSteps, attempts, receipts } = setup();
    const scheduler = new ConcurrencyScheduler(db);
    const reconciler = new EffectReconciler(attempts, receipts, scheduler);
    const attempt = startAttempt(runSteps, attempts);
    reserveFor(scheduler, attempt.executionAttemptId);
    receipts.record({
      effectId: 'effect-1',
      executionAttemptId: attempt.executionAttemptId,
      engineAdapterId: 'promptfoo',
      engineRequestId: 'req-1',
      idempotencyKey: null,
      capability: 'QUERYABLE_RECEIPT',
      startedAt: new Date(0).toISOString(),
      acknowledgedAt: null,
      externalReceiptRef: null,
      reconciliationToken: null,
      outcome: 'CONFIRMED',
    });

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'QUERYABLE_RECEIPT' });

    expect(result.decision.action).toBe('PROCEED_TO_NATIVE_RESULT');
    expect(result.attempt.terminalReason).toBeNull();
    expect(result.reservation).toBeNull(); // nothing was settled, so nothing was disposed
    expect(scheduler.activeReservations()).toHaveLength(1); // still running, still legitimately holding
  });
});
