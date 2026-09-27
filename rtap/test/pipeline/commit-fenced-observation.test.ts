import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { commitFencedObservation } from '../../src/pipeline/commit-fenced-observation.js';

const LEASE_MS = 1000;

function validObservation(id: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1',
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

function validEvent(id: string) {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${id}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [id],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId: 'target-1', probeId: 'probe-1', verdict: 'VULNERABLE' },
  };
}

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' });
  runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
  const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
  return { db, runSteps, attempts, observations, events, step, attempt };
}

describe('commitFencedObservation — single-transaction guarantee', () => {
  it('a successful commit persists the Observation, the CampaignEvent, and marks the attempt COMPLETED, all together', () => {
    const { db, attempts, observations, events, step, attempt } = setup();
    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
    );
    expect(result.committed).toBe(true);
    expect(observations.listByAssessmentRun('run-1')).toHaveLength(1);
    expect(events.listByCampaign('campaign-1')).toHaveLength(1);
    expect(attempts.get(attempt.executionAttemptId)?.terminalReason).toBe('COMPLETED');
  });

  it('a rejected (stale/terminal) bind commits its quarantine record even though nothing else was written', () => {
    const { db, attempts, observations, events, step, attempt } = setup();
    attempts.markTerminal(attempt.executionAttemptId, 'CANCELLED');

    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
    );
    expect(result.committed).toBe(false);
    expect(observations.listByAssessmentRun('run-1')).toHaveLength(0);
    expect(attempts.quarantineHistory(step.id)).toHaveLength(1); // durably recorded, not lost
  });

  it('a failure after the fencing check and the Observation insert — but before the transaction completes — rolls back the Observation too, and leaves the attempt non-terminal, retryable', () => {
    const { db, attempts, observations, events, step, attempt } = setup();

    // The Observation insert (first) succeeds; the CampaignEvent insert (second,
    // still inside the same transaction commitFencedObservation opened) fails
    // schema validation. Before this fix, the Observation/Event pair had its own
    // separate transaction from the fencing check and the later markTerminal()
    // call — this proves all of it is now one atomic unit, not three.
    expect(() =>
      commitFencedObservation(
        db,
        observations,
        events,
        attempts,
        { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
        validObservation('obs-1'),
        { ...validEvent('obs-1'), eventType: 'NotARealEventType' },
      ),
    ).toThrow();

    expect(observations.listByAssessmentRun('run-1')).toHaveLength(0);
    expect(events.listByCampaign('campaign-1')).toHaveLength(0);
    const reloaded = attempts.get(attempt.executionAttemptId);
    expect(reloaded?.terminalReason).toBeNull(); // never reached markTerminal, and even if it had, the rollback would have reverted it

    // The attempt is still genuinely usable — the failed attempt at commit did
    // not consume or corrupt it.
    const retry = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
    );
    expect(retry.committed).toBe(true);
    expect(observations.listByAssessmentRun('run-1')).toHaveLength(1);
    expect(attempts.get(attempt.executionAttemptId)?.terminalReason).toBe('COMPLETED');
  });

  it('does not leave a half-committed state visible to a later read within the same connection after a rollback', () => {
    const { db, attempts, observations, events, step, attempt } = setup();
    try {
      commitFencedObservation(
        db,
        observations,
        events,
        attempts,
        { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
        validObservation('obs-1'),
        { ...validEvent('obs-1'), eventType: 'NotARealEventType' },
      );
    } catch {
      // expected
    }
    // A second, unrelated attempt on the same RunStep (fresh attempt, since the
    // first is still active/non-terminal — reuse it) must still work cleanly.
    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
    );
    expect(result.committed).toBe(true);
  });

  it('audit #7: a successful commit releases the attempt\'s reservation, in the same transaction as marking the attempt COMPLETED', () => {
    const { db, attempts, observations, events, step, attempt } = setup();
    const scheduler = new ConcurrencyScheduler(db);
    const reservation = scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: attempt.executionAttemptId,
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) return;

    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
      new Date(),
      scheduler,
    );

    expect(result.committed).toBe(true);
    expect(scheduler.activeReservations()).toHaveLength(0); // released, not left dangling
  });

  it('without a scheduler, a successful commit leaves any existing reservation untouched — the release is opt-in, not automatic', () => {
    const { db, attempts, observations, events, step, attempt } = setup();
    const scheduler = new ConcurrencyScheduler(db);
    const reservation = scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: attempt.executionAttemptId,
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    expect(reservation.reserved).toBe(true);

    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
    );

    expect(result.committed).toBe(true);
    expect(scheduler.activeReservations()).toHaveLength(1); // no scheduler was passed — nothing released it
  });

  it('a rejected (quarantined) bind does not release the attempt\'s reservation — the attempt\'s real resolution is unknown to this call', () => {
    const { db, attempts, observations, events, step, attempt } = setup();
    const scheduler = new ConcurrencyScheduler(db);
    const reservation = scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: attempt.executionAttemptId,
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) return;
    attempts.markTerminal(attempt.executionAttemptId, 'CANCELLED');

    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1'),
      validEvent('obs-1'),
      new Date(),
      scheduler,
    );

    expect(result.committed).toBe(false);
    expect(scheduler.activeReservations()).toHaveLength(1); // still held — a caller must release it explicitly on this path
  });
});
