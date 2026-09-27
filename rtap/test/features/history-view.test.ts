import { describe, expect, it } from 'vitest';
import { buildHistoryView, buildSettledAttemptsByReason, vulnerabilityClassOf, targetProbeKey } from '../../src/features/history-view.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';

const LEASE_MS = 1000;

function event(overrides: Partial<CampaignEventEnvelope> & { sequence: number; payload: Record<string, unknown> }): CampaignEventEnvelope {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${overrides.sequence}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    committedAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    ...overrides,
  };
}

describe('vulnerabilityClassOf', () => {
  it('takes the part before the colon', () => {
    expect(vulnerabilityClassOf('prompt-injection:base64')).toBe('prompt-injection');
  });
  it('is total for a probeId with no colon', () => {
    expect(vulnerabilityClassOf('unknown-plugin')).toBe('unknown-plugin');
  });
});

describe('buildHistoryView', () => {
  const events: CampaignEventEnvelope[] = [
    event({ sequence: 0, payload: { targetId: 't1', probeId: 'p1:base64', verdict: 'VULNERABLE' } }),
    event({ sequence: 1, payload: { targetId: 't1', probeId: 'p1:base64', verdict: 'RESISTANT' } }),
    event({ sequence: 2, payload: { targetId: 't1', probeId: 'p2:default', verdict: 'UNVERIFIED' } }),
  ];

  it('only consumes events strictly before asOfSequence', () => {
    const view = buildHistoryView(events, 'campaign-1', 1);
    expect(view.totalEventsConsumed).toBe(1);
    expect(view.byTargetProbe.get(targetProbeKey('t1', 'p1:base64'))?.committedOutcomes).toBe(1);
    expect(view.byTargetProbe.has(targetProbeKey('t1', 'p2:default'))).toBe(false);
  });

  it('sees everything strictly before the end when asOfSequence is past the last event', () => {
    const view = buildHistoryView(events, 'campaign-1', 3);
    expect(view.totalEventsConsumed).toBe(3);
    expect(view.byTargetProbe.get(targetProbeKey('t1', 'p1:base64'))).toEqual({ committedOutcomes: 2, vulnerable: 1, resistant: 1, unverified: 0, error: 0 });
  });

  it('ignores events from other campaigns', () => {
    const other = [...events, event({ sequence: 5, campaignId: 'campaign-2', payload: { targetId: 't9', probeId: 'p9', verdict: 'VULNERABLE' } })];
    const view = buildHistoryView(other, 'campaign-1', 10);
    expect(view.byTargetProbe.has(targetProbeKey('t9', 'p9'))).toBe(false);
  });

  it('tracks vulnerabilityClassesSeen and confirmedFindingTargetProbes', () => {
    const view = buildHistoryView(events, 'campaign-1', 3);
    expect(view.vulnerabilityClassesSeen).toEqual(new Set(['p1', 'p2']));
    expect(view.confirmedFindingTargetProbes).toEqual(new Set([targetProbeKey('t1', 'p1:base64')]));
  });

  it('an empty event list at asOfSequence 0 produces an empty view (the "before anything happened" world)', () => {
    const view = buildHistoryView(events, 'campaign-1', 0);
    expect(view.totalEventsConsumed).toBe(0);
    expect(view.byTargetProbe.size).toBe(0);
  });

  it('scopes attempts/confirmed-vulnerable by (targetId, probeId) — the same probeId against a different target is untouched', () => {
    const multiTarget: CampaignEventEnvelope[] = [
      event({ sequence: 0, payload: { targetId: 't-A', probeId: 'p1:base64', verdict: 'VULNERABLE' } }),
      event({ sequence: 1, payload: { targetId: 't-B', probeId: 'p1:base64', verdict: 'UNVERIFIED' } }),
    ];
    const view = buildHistoryView(multiTarget, 'campaign-1', 2);
    expect(view.confirmedFindingTargetProbes.has(targetProbeKey('t-A', 'p1:base64'))).toBe(true);
    expect(view.confirmedFindingTargetProbes.has(targetProbeKey('t-B', 'p1:base64'))).toBe(false);
    expect(view.byTargetProbe.get(targetProbeKey('t-A', 'p1:base64'))?.committedOutcomes).toBe(1);
    expect(view.byTargetProbe.get(targetProbeKey('t-B', 'p1:base64'))?.committedOutcomes).toBe(1);
  });

  it('settledAttemptsByReason defaults to an empty map — every caller that predates this field', () => {
    const view = buildHistoryView(events, 'campaign-1', 3);
    expect(view.settledAttemptsByReason.size).toBe(0);
  });

  it('a caller-supplied settledAttemptsByReason map is carried through verbatim', () => {
    const supplied = new Map([[targetProbeKey('t1', 'p1:base64'), { ...ZERO_COUNTS, AUTHORIZATION_DENIED: 2 }]]);
    const view = buildHistoryView(events, 'campaign-1', 3, supplied);
    expect(view.settledAttemptsByReason).toBe(supplied);
  });
});

const ZERO_COUNTS = {
  COMPLETED: 0,
  CANCELLED: 0,
  TIMED_OUT_BEFORE_EFFECT: 0,
  AUTHORIZATION_DENIED: 0,
  CAPABILITY_UNSUPPORTED: 0,
  TARGET_UNAVAILABLE: 0,
  FAILED_BEFORE_EFFECT: 0,
  UNKNOWN_EFFECT_OUTCOME: 0,
  NORMALIZATION_FAILED: 0,
  STALE_LEASE_RESULT: 0,
  OBSERVATION_COMMITTED: 0,
} as const;

describe('buildSettledAttemptsByReason', () => {
  function setup() {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    return { db, runSteps, attempts };
  }

  it('groups settled attempts by (targetId, probeId), counting each TerminalReason verbatim', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'prompt-injection:base64' }, new Date(), {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    attempts.markTerminal(attempt.executionAttemptId, 'AUTHORIZATION_DENIED');

    const byReason = buildSettledAttemptsByReason(attempts.listByCampaign('campaign-1'), runSteps);
    const key = targetProbeKey('target-1', 'prompt-injection:base64');
    expect(byReason.get(key)?.AUTHORIZATION_DENIED).toBe(1);
    expect(byReason.get(key)?.COMPLETED).toBe(0);
  });

  it('excludes non-terminal attempts entirely', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'p1' }, new Date(), {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });

    const byReason = buildSettledAttemptsByReason(attempts.listByCampaign('campaign-1'), runSteps);
    expect(byReason.size).toBe(0);
  });

  it('excludes an attempt whose RunStep payload does not structurally carry a probeId — silently, not a crash', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', { justSomeField: true }, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    attempts.markTerminal(attempt.executionAttemptId, 'COMPLETED');

    const byReason = buildSettledAttemptsByReason(attempts.listByCampaign('campaign-1'), runSteps);
    expect(byReason.size).toBe(0);
  });

  it('counts more than one settled attempt for the same (targetId, probeId) key', () => {
    const { runSteps, attempts } = setup();
    const payload = { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'p1' };
    const { step: step1 } = runSteps.enqueue('run-1', 'k1', payload, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
    const { step: step2 } = runSteps.enqueue('run-1', 'k2', payload, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt1 = attempts.start({ assessmentRunId: 'run-1', runStepId: step1.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    const attempt2 = attempts.start({ assessmentRunId: 'run-1', runStepId: step2.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-2' });
    attempts.markTerminal(attempt1.executionAttemptId, 'TARGET_UNAVAILABLE');
    attempts.markTerminal(attempt2.executionAttemptId, 'TARGET_UNAVAILABLE');

    const byReason = buildSettledAttemptsByReason(attempts.listByCampaign('campaign-1'), runSteps);
    expect(byReason.get(targetProbeKey('target-1', 'p1'))?.TARGET_UNAVAILABLE).toBe(2);
  });
});
