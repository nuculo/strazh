import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { OutboxStore } from '../../src/events/outbox.js';
import { CampaignWorldMaterializer } from '../../src/world/materializer.js';
import { commitFencedObservation } from '../../src/pipeline/commit-fenced-observation.js';
import { replay } from '../../src/world/replay.js';
import { fingerprint } from '../../src/world/fingerprint.js';

const LEASE_MS = 1000;

function validObservation(id: string, targetId: string, probeId: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId,
    probeId,
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

function validEvent(id: string, targetId: string, probeId: string) {
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
    payload: { targetId, probeId, verdict: 'VULNERABLE' },
  };
}

/**
 * Audit finding #4, end to end: commitFencedObservation() (the sole canonical
 * commit path — see rtap/README.md's fenced-commit bug fix) now also durably rows
 * an outbox entry as an ambient side effect of CampaignEventStore.append(), and
 * CampaignWorldMaterializer.advance() picks it up without either the pipeline
 * function or the caller doing anything outbox-specific.
 */
describe('outbox + materializer, driven through the real commit path', () => {
  function setup() {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);
    const outbox = new OutboxStore(db);
    const materializer = new CampaignWorldMaterializer(db, events, outbox);
    return { db, runSteps, attempts, observations, events, outbox, materializer };
  }

  function leaseAndStartAttempt(runSteps: RunStepStore, attempts: ExecutionAttemptStore, stepKey: string, probeId: string) {
    const { step } = runSteps.enqueue('run-1', stepKey, { probeId });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${stepKey}` });
    return { step, attempt };
  }

  it('a committed observation produces an undelivered outbox row, and advance() materializes it', () => {
    const { db, runSteps, attempts, observations, events, outbox, materializer } = setup();
    const { step, attempt } = leaseAndStartAttempt(runSteps, attempts, 'key-1', 'probe-1');

    commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1', 'target-1', 'probe-1'),
      validEvent('obs-1', 'target-1', 'probe-1'),
    );

    expect(outbox.listUndelivered('campaign-1')).toHaveLength(1);

    const result = materializer.advance('campaign-1');
    expect(result.eventsApplied).toBe(1);
    expect(outbox.listUndelivered('campaign-1')).toHaveLength(0);
    expect([...result.world.entities.keys()]).toContain('target-1');
  });

  it('a rejected (quarantined) commit never reaches the event log, so it never reaches the outbox either', () => {
    const { db, runSteps, attempts, observations, events, outbox } = setup();
    const { step, attempt } = leaseAndStartAttempt(runSteps, attempts, 'key-1', 'probe-1');
    attempts.markTerminal(attempt.executionAttemptId, 'CANCELLED');

    const result = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      validObservation('obs-1', 'target-1', 'probe-1'),
      validEvent('obs-1', 'target-1', 'probe-1'),
    );

    expect(result.committed).toBe(false);
    expect(outbox.listAll('campaign-1')).toHaveLength(0);
  });

  it('after several commits split across multiple advance() calls, the materialized world fingerprints identically to a full replay', () => {
    const { db, runSteps, attempts, observations, events, materializer } = setup();

    const probes: Array<[string, string]> = [
      ['target-1', 'probe-1'],
      ['target-1', 'probe-2'],
      ['target-2', 'probe-1'],
    ];
    probes.forEach(([targetId, probeId], i) => {
      const { step, attempt } = leaseAndStartAttempt(runSteps, attempts, `key-${i}`, probeId);
      commitFencedObservation(
        db,
        observations,
        events,
        attempts,
        { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: `ref-${i}` },
        validObservation(`obs-${i}`, targetId, probeId),
        validEvent(`obs-${i}`, targetId, probeId),
      );
      // Advance after every single commit — proves incremental catch-up works one
      // event at a time, not just in one big batch at the end.
      materializer.advance('campaign-1');
    });

    const materialized = materializer.current('campaign-1');
    const replayed = replay(events.listByCampaign('campaign-1'), 'campaign-1').world;

    expect(materialized).not.toBeNull();
    expect(fingerprint(materialized!)).toBe(fingerprint(replayed));
  });
});
