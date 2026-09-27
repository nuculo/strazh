import { describe, expect, it } from 'vitest';
import { computeUtilityLabel, DEFAULT_UTILITY_POLICY } from '../../src/training/utility-label-policy.js';
import { buildHistoryView } from '../../src/features/history-view.js';

const emptyHistory = buildHistoryView([], 'campaign-1', 0);

function vulnerabilityEvent(sequence: number, targetId: string, probeId: string) {
  return {
    schemaVersion: '1.0.0',
    eventId: `e${sequence}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    sequence,
    occurredAt: '2026-08-30T00:00:00.000Z',
    committedAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId, probeId, verdict: 'VULNERABLE' },
  };
}

describe('computeUtilityLabel', () => {
  it('a first-ever VULNERABLE finding scores higher than a repeat confirmation', () => {
    const first = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }, emptyHistory);

    const historyWithPriorFind = buildHistoryView([vulnerabilityEvent(0, 't1', 'p1')], 'campaign-1', 1);
    const repeat = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }, historyWithPriorFind);

    expect(first).toBeGreaterThan(repeat);
  });

  it('a probe already confirmed VULNERABLE against Target A still scores as a genuine new finding against Target B — the exact bug this phase fixes', () => {
    const historyFromTargetA = buildHistoryView([vulnerabilityEvent(0, 't-A', 'p1')], 'campaign-1', 1);
    const firstOnB = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't-B', probeId: 'p1', verdict: 'VULNERABLE' }, historyFromTargetA);
    const repeatOnA = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't-A', probeId: 'p1', verdict: 'VULNERABLE' }, historyFromTargetA);

    expect(firstOnB).toBeGreaterThan(repeatOnA);
    // And matches exactly what a genuinely first-ever finding scores, with no cross-target penalty at all.
    const trulyFirst = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't-B', probeId: 'p1', verdict: 'VULNERABLE' }, emptyHistory);
    expect(firstOnB).toBe(trulyFirst);
  });

  it('ERROR and UNVERIFIED score lower than RESISTANT (wasted budget vs a real answer)', () => {
    const error = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'ERROR' }, emptyHistory);
    const resistant = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' }, emptyHistory);
    expect(error).toBeLessThan(resistant);
  });

  it('is a pure function: identical inputs always produce the identical label', () => {
    const a = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }, emptyHistory);
    const b = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }, emptyHistory);
    expect(a).toBe(b);
  });

  it('a custom policy version changes the label without touching call sites', () => {
    const doubleWeight = { policyVersion: '2.0.0', weights: { ...DEFAULT_UTILITY_POLICY.weights, newConfirmedFinding: 2.0 } };
    const base = computeUtilityLabel(DEFAULT_UTILITY_POLICY, { targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }, emptyHistory);
    const doubled = computeUtilityLabel(doubleWeight, { targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }, emptyHistory);
    expect(doubled).toBeGreaterThan(base);
  });
});
