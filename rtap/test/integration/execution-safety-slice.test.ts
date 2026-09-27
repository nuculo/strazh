import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
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
 * Phase 4.5.1 vertical slice: EXECUTION_SAFETY_RECOVERY.md §7.1's own late-result
 * sequence diagram, played out for real against RunStepStore + ExecutionAttemptStore,
 * then through commitFencedObservation into the *same* Phase 4 world reducer every
 * other adapter uses — proving the fencing gate composes with, rather than
 * replaces, the existing commit/replay path.
 */
describe('Phase 4.5.1 vertical slice: execution identity and fencing', () => {
  it('a late result from a superseded lease is quarantined, never committed, never enters the replayed world; the current-generation result commits and replays normally', () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1:strategy-1' });
    const t0 = new Date('2026-08-30T00:00:00.000Z');

    // Lease generation 1 — worker A starts an attempt, then its lease expires before it reports back.
    runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: LEASE_MS, now: () => t0 });
    const attemptA = attempts.start(
      { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-a' },
      t0,
    );

    // Lease generation 2 — worker B takes over and completes the work.
    const t1 = new Date(t0.getTime() + LEASE_MS + 1);
    runSteps.lease('run-1', { owner: 'worker-b', leaseDurationMs: LEASE_MS, now: () => t1 });
    const attemptB = attempts.start(
      { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-b' },
      t1,
    );

    // Worker A's engine finally responds — late, for a lease generation that no longer exists.
    const staleObservation = validObservation('obs-stale-from-a');
    const staleEvent = eventForObservation(staleObservation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: t1.toISOString() });
    const staleCommit = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attemptA.executionAttemptId, nativeResultRef: 'ref-a-late' },
      staleObservation,
      staleEvent,
      t1,
    );
    expect(staleCommit.committed).toBe(false);
    if (!staleCommit.committed) {
      expect(staleCommit.bindResult.reason).toBe('STALE_LEASE_RESULT');
    }

    // Worker B's on-time result for the current generation.
    const currentObservation = validObservation('obs-current-from-b');
    const currentEvent = eventForObservation(currentObservation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: t1.toISOString() });
    const currentCommit = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attemptB.executionAttemptId, nativeResultRef: 'ref-b-current' },
      currentObservation,
      currentEvent,
      t1,
    );
    expect(currentCommit.committed).toBe(true);

    // Exactly one Observation exists — the stale one never entered the store.
    const allObservations = observations.listByAssessmentRun('run-1');
    expect(allObservations).toHaveLength(1);
    expect(allObservations[0]!['id']).toBe('obs-current-from-b');
    expect(allObservations[0]!['executionAttemptId']).toBe(attemptB.executionAttemptId);

    // Exactly one CampaignEvent exists, and it replays into the world exactly as any other adapter's event would.
    const allEvents = events.listByCampaign('campaign-1');
    expect(allEvents).toHaveLength(1);
    const result = replay(allEvents, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
    expect(result.world.entities.get('target-1')).toMatchObject({ type: 'Target' });

    // The rejection is itself durable and auditable.
    const quarantine = attempts.quarantineHistory(step.id);
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({ executionAttemptId: attemptA.executionAttemptId, reason: 'STALE_LEASE_RESULT' });
  });
});
