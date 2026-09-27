import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../src/db/connection.js';
import { ObservationStore } from '../src/observations/store.js';
import { CampaignEventStore } from '../src/events/store.js';
import { commitObservationWithEvent } from '../src/pipeline/commit-observation.js';

function validObservation() {
  return {
    id: 'obs-1',
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
      nativeResultId: 'native-result-1',
      graderKind: 'llm-judge',
    },
  };
}

function validEvent() {
  return {
    schemaVersion: '1.0.0',
    eventId: 'evt-1',
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: ['obs-1'],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: {},
  };
}

describe('commitObservationWithEvent', () => {
  it('commits both the Observation and the CampaignEvent together', () => {
    const db = openInMemoryDatabase();
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    commitObservationWithEvent(db, observations, events, validObservation(), validEvent());

    expect(observations.listByAssessmentRun('run-1')).toHaveLength(1);
    expect(events.listByCampaign('campaign-1')).toHaveLength(1);
  });

  it('rolls back the Observation insert when the CampaignEvent fails validation — no orphaned Observation', () => {
    const db = openInMemoryDatabase();
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    expect(() =>
      commitObservationWithEvent(db, observations, events, validObservation(), {
        ...validEvent(),
        eventType: 'NotARealEventType',
      }),
    ).toThrow();

    expect(observations.listByAssessmentRun('run-1')).toHaveLength(0);
    expect(events.listByCampaign('campaign-1')).toHaveLength(0);
  });

  it('does not leave a half-committed state visible to a second connection-level read within the same db', () => {
    const db = openInMemoryDatabase();
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    try {
      commitObservationWithEvent(db, observations, events, validObservation(), {
        ...validEvent(),
        eventType: 'NotARealEventType',
      });
    } catch {
      // expected
    }

    // A subsequent, unrelated valid commit must still work — the rollback did not
    // corrupt the transaction state of the connection.
    commitObservationWithEvent(db, observations, events, validObservation(), validEvent());
    expect(observations.listByAssessmentRun('run-1')).toHaveLength(1);
  });
});
