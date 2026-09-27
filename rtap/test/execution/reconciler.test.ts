import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { EffectReceiptStore } from '../../src/execution/effect-receipt-store.js';
import { EffectReconciler } from '../../src/execution/reconciler.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import type { EffectReceipt } from '../../src/execution/effect.js';

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const receipts = new EffectReceiptStore(db);
  const reconciler = new EffectReconciler(attempts, receipts, new ConcurrencyScheduler(db));
  return { db, runSteps, attempts, receipts, reconciler };
}

function baseReceipt(overrides: Partial<EffectReceipt>): EffectReceipt {
  return {
    effectId: 'effect-1',
    executionAttemptId: 'attempt-1',
    engineAdapterId: 'promptfoo',
    engineRequestId: 'req-1',
    idempotencyKey: null,
    capability: 'AT_MOST_ONCE_UNPROVEN',
    startedAt: '2026-08-30T00:00:00.000Z',
    acknowledgedAt: null,
    externalReceiptRef: null,
    reconciliationToken: null,
    outcome: 'UNKNOWN',
    ...overrides,
  };
}

describe('EffectReconciler.reconcile', () => {
  it('throws for an unknown attempt', () => {
    const { reconciler } = setup();
    expect(() => reconciler.reconcile({ executionAttemptId: 'no-such-attempt', capability: 'AT_MOST_ONCE_UNPROVEN' })).toThrow();
  });

  it('refuses to reconcile an already-terminal attempt', () => {
    const { runSteps, attempts, reconciler } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    attempts.markTerminal(attempt.executionAttemptId, 'COMPLETED');
    expect(() => reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' })).toThrow();
  });

  it('with no EffectReceipt at all (crash before the local EFFECT_STARTED write), treats the outcome as ambiguous — never as proven absent', () => {
    const { runSteps, attempts, reconciler } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' });
    expect(result.decision.action).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(result.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
  });

  it('a FAILED_BEFORE_EFFECT receipt is genuine proof of absence — retries and marks the old attempt FAILED_BEFORE_EFFECT, even under AT_MOST_ONCE_UNPROVEN', () => {
    const { runSteps, attempts, receipts, reconciler } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    receipts.record(baseReceipt({ executionAttemptId: attempt.executionAttemptId, outcome: 'FAILED_BEFORE_EFFECT' }));

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' });
    expect(result.decision.action).toBe('RETRY_SAME_EFFECT');
    expect(result.attempt.terminalReason).toBe('FAILED_BEFORE_EFFECT');
  });

  it('a CONFIRMED receipt short-circuits straight to PROCEED_TO_NATIVE_RESULT without consulting capability, and leaves the attempt open', () => {
    const { runSteps, attempts, receipts, reconciler } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    receipts.record(baseReceipt({ executionAttemptId: attempt.executionAttemptId, outcome: 'CONFIRMED' }));

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' });
    expect(result.decision.action).toBe('PROCEED_TO_NATIVE_RESULT');
    expect(result.attempt.terminalReason).toBeNull();
  });

  it('IDEMPOTENT_BY_KEY on an ambiguous (UNKNOWN) receipt retries and marks the old attempt UNKNOWN_EFFECT_OUTCOME, not FAILED_BEFORE_EFFECT', () => {
    const { runSteps, attempts, receipts, reconciler } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    receipts.record(baseReceipt({ executionAttemptId: attempt.executionAttemptId, capability: 'IDEMPOTENT_BY_KEY', outcome: 'UNKNOWN' }));

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'IDEMPOTENT_BY_KEY' });
    expect(result.decision.action).toBe('RETRY_SAME_EFFECT');
    expect(result.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
  });

  it('the old attempt, once reconciled, rejects a stray duplicate native result via the normal fencing path', () => {
    const { runSteps, attempts, reconciler } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 1000 });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' });

    const dup = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'late-result' });
    expect(dup).toEqual({ permitted: false, reason: 'ATTEMPT_ALREADY_TERMINAL' });
  });
});
