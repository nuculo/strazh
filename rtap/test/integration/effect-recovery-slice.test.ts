import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { EffectReceiptStore } from '../../src/execution/effect-receipt-store.js';
import { EffectReconciler } from '../../src/execution/reconciler.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { commitFencedObservation } from '../../src/pipeline/commit-fenced-observation.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { replay } from '../../src/world/replay.js';

const LEASE_MS = 1000;

function validObservation(id: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1:strategy-1',
    assessmentRunId: 'run-1',
    verdict: 'VULNERABLE',
    evidenceRefs: [],
    provenance: {
      engineId: 'promptfoo',
      engineVersion: '0.122.0',
      adapterVersion: '0.1.0',
      schemaVersion: '1.0.0',
      nativeRunId: 'native-run-1',
      nativeResultId: id,
      graderKind: 'llm-judge',
    },
  };
}

/**
 * Phase 4.5.2 vertical slice: an attempt dispatches an effect, the worker crashes
 * before acknowledging it (an ambiguous EffectReceipt is all that's left), the
 * Recovery Reconciler decides — from durable state alone — that this specific
 * operation's IDEMPOTENT_BY_KEY capability makes a retry safe, the old attempt is
 * marked terminal, a genuinely new attempt retries and succeeds, and the result
 * commits and replays through the unmodified Phase 4 world reducer exactly once.
 */
describe('Phase 4.5.2 vertical slice: effect journal and recovery', () => {
  it('an ambiguous crash is reconciled via capability, retried under a new attempt, and produces exactly one Observation and CampaignEvent', () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const receipts = new EffectReceiptStore(db);
    const reconciler = new EffectReconciler(attempts, receipts, new ConcurrencyScheduler(db));
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1:strategy-1' });
    const t0 = new Date('2026-08-30T00:00:00.000Z');

    // Attempt 1 dispatches an effect, then the worker crashes before ACK.
    runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: LEASE_MS, now: () => t0 });
    const attempt1 = attempts.start(
      { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      t0,
    );
    receipts.record({
      effectId: 'effect-1',
      executionAttemptId: attempt1.executionAttemptId,
      engineAdapterId: 'promptfoo',
      engineRequestId: 'req-1',
      idempotencyKey: 'idem-key-1',
      capability: 'IDEMPOTENT_BY_KEY',
      startedAt: t0.toISOString(),
      acknowledgedAt: null,
      externalReceiptRef: null,
      reconciliationToken: null,
      outcome: 'UNKNOWN',
    });

    // A later process discovers the interrupted attempt and reconciles it.
    const reconciliation = reconciler.reconcile({ executionAttemptId: attempt1.executionAttemptId, capability: 'IDEMPOTENT_BY_KEY' });
    expect(reconciliation.decision.action).toBe('RETRY_SAME_EFFECT');
    expect(reconciliation.attempt.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME'); // capability-safe, not proven absent

    // The original effect eventually does respond, late — it must not bind to the now-terminal attempt.
    const lateBind = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attempt1.executionAttemptId, nativeResultRef: 'ref-late-from-attempt-1' });
    expect(lateBind).toEqual({ permitted: false, reason: 'ATTEMPT_ALREADY_TERMINAL' });

    // Retry: new lease generation, new attempt, same idempotency key (per §12 node I).
    const t1 = new Date(t0.getTime() + LEASE_MS + 1);
    runSteps.lease('run-1', { owner: 'worker-b', leaseDurationMs: LEASE_MS, now: () => t1 });
    const attempt2 = attempts.start(
      { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-2' },
      t1,
    );
    receipts.record({
      effectId: 'effect-1', // same effect id — IDEMPOTENT_BY_KEY sanctions this reuse
      executionAttemptId: attempt2.executionAttemptId,
      engineAdapterId: 'promptfoo',
      engineRequestId: 'req-2',
      idempotencyKey: 'idem-key-1',
      capability: 'IDEMPOTENT_BY_KEY',
      startedAt: t1.toISOString(),
      acknowledgedAt: t1.toISOString(),
      externalReceiptRef: null,
      reconciliationToken: null,
      outcome: 'CONFIRMED',
    });

    const observation = validObservation('obs-1');
    const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: t1.toISOString() });
    const commit = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt2.executionAttemptId, nativeResultRef: 'ref-attempt-2' },
      observation,
      eventInput,
      t1,
    );
    expect(commit.committed).toBe(true);

    // Exactly one Observation and one CampaignEvent exist, despite the crash and retry.
    expect(observations.listByAssessmentRun('run-1')).toHaveLength(1);
    const allEvents = events.listByCampaign('campaign-1');
    expect(allEvents).toHaveLength(1);

    const result = replay(allEvents, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
    expect(result.world.entities.get('target-1')).toMatchObject({ type: 'Target' });
  });
});
