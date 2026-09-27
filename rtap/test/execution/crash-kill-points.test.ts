import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { EffectReceiptStore } from '../../src/execution/effect-receipt-store.js';
import { EffectReconciler } from '../../src/execution/reconciler.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import type { EffectReceipt } from '../../src/execution/effect.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §13's crash matrix, for the rows 4.5.2 actually
 * introduces machinery for. "Recovery Reconciler works from durable state, not
 * process memory" (§12) means a crash at a given point is fully characterized by
 * what got durably written before it — so each test here *is* the crash: it
 * constructs exactly the DB rows that kill point implies (no more, no less) and
 * checks the reconciler reaches the doc's stated expected outcome. No real process
 * is killed; none needs to be, given that stated equivalence.
 *
 * Rows not covered here: "after native result persistence, before normalization"
 * and "after normalization, before Observation commit" are schema-validation and
 * atomic-transaction concerns already exercised by ObservationStore/
 * commitObservationWithEvent's own tests (pre-4.5.2) — nothing new to add. Rows
 * about authorization/interceptors/lease-takeover belong to 4.5.1 (already tested)
 * or 4.5.3/4.5.4 (not built yet).
 */
function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const receipts = new EffectReceiptStore(db);
  const reconciler = new EffectReconciler(attempts, receipts, new ConcurrencyScheduler(db));
  const { step } = runSteps.enqueue('run-1', 'k1', {});
  runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 5000 });
  const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
  return { step, attempts, receipts, reconciler, attempt };
}

function baseReceipt(overrides: Partial<EffectReceipt>): EffectReceipt {
  return {
    effectId: 'effect-1',
    executionAttemptId: 'attempt-placeholder',
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

describe('§13 kill point: after dispatch, before the local EFFECT_STARTED write', () => {
  it('no EffectReceipt exists at all — outcome is unknown, never assumed absent, for every capability', () => {
    for (const capability of ['IDEMPOTENT_BY_KEY', 'QUERYABLE_RECEIPT', 'COMPENSATABLE', 'AT_MOST_ONCE_UNPROVEN'] as const) {
      const { reconciler, attempts, step } = setup();
      const fresh = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${capability}` });
      const result = reconciler.reconcile({ executionAttemptId: fresh.executionAttemptId, capability });
      // Never PROCEED_TO_NATIVE_RESULT (that would mean treating absence-of-receipt as confirmation) —
      // exactly the doc's rule that a lost ACK never proves absence of effect.
      expect(result.decision.action).not.toBe('PROCEED_TO_NATIVE_RESULT');
      if (capability !== 'IDEMPOTENT_BY_KEY') {
        // IDEMPOTENT_BY_KEY is the one capability allowed to retry even without proof.
        expect(result.decision.action).not.toBe('RETRY_SAME_EFFECT');
      }
    }
  });
});

describe('§13 kill point: after effect dispatch, before ACK', () => {
  it('EffectReceipt exists with outcome UNKNOWN — reconciliation follows capability; AT_MOST_ONCE_UNPROVEN never blind-retries', () => {
    const { reconciler, receipts, attempt } = setup();
    receipts.record(baseReceipt({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN', outcome: 'UNKNOWN', acknowledgedAt: null }));

    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'AT_MOST_ONCE_UNPROVEN' });
    expect(result.decision.action).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(result.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
  });
});

describe('§13 kill point: after ACK, before native result persistence', () => {
  it('EffectReceipt is acknowledged but outcome is still UNKNOWN — QUERYABLE_RECEIPT must query, not guess', () => {
    const { reconciler, receipts, attempt } = setup();
    receipts.record(
      baseReceipt({ executionAttemptId: attempt.executionAttemptId, capability: 'QUERYABLE_RECEIPT', outcome: 'UNKNOWN', acknowledgedAt: '2026-08-30T00:00:05.000Z' }),
    );

    const firstPass = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'QUERYABLE_RECEIPT' });
    expect(firstPass.decision.action).toBe('QUERY_EXTERNAL_RECEIPT');
    expect(firstPass.attempt.terminalReason).toBeNull(); // still open — querying is the caller's next real action, not a terminal outcome

    // Caller performs the (adapter-specific, out of scope here) query and it comes back "still unknown".
    const secondPass = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'QUERYABLE_RECEIPT', queriedReceiptOutcome: 'STILL_UNKNOWN' });
    expect(secondPass.decision.action).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(secondPass.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
  });

  it('a query that confirms the effect occurred proceeds to the native result path, not a retry', () => {
    const { reconciler, receipts, attempt } = setup();
    receipts.record(
      baseReceipt({ executionAttemptId: attempt.executionAttemptId, capability: 'QUERYABLE_RECEIPT', outcome: 'UNKNOWN', acknowledgedAt: '2026-08-30T00:00:05.000Z' }),
    );
    const result = reconciler.reconcile({ executionAttemptId: attempt.executionAttemptId, capability: 'QUERYABLE_RECEIPT', queriedReceiptOutcome: 'CONFIRMED' });
    expect(result.decision.action).toBe('PROCEED_TO_NATIVE_RESULT');
    expect(result.attempt.terminalReason).toBeNull();
  });
});
