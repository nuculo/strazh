import { describe, expect, it } from 'vitest';
import { enumerateEligibleCandidates, blocksEligibility, DEFAULT_ELIGIBILITY_POLICY } from '../../src/candidates/enumerate.js';
import { buildHistoryView, targetProbeKey } from '../../src/features/history-view.js';
import type { ProbeCatalogEntry } from '../../src/candidates/catalog.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';
import type { TerminalReason } from '../../src/execution/types.js';

const ZERO_COUNTS: Record<TerminalReason, number> = {
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
};

const catalog: ProbeCatalogEntry[] = [
  { probeId: 'p1:s1', mandatory: false },
  { probeId: 'p2:s1', mandatory: false },
  { probeId: 'p3:s1', mandatory: true },
];

function event(sequence: number, targetId: string, probeId: string, verdict: string): CampaignEventEnvelope {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${sequence}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    sequence,
    occurredAt: '2026-08-30T00:00:00.000Z',
    committedAt: '2026-08-30T00:00:00.000Z',
    eventType: 'ResistanceObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId, probeId, verdict },
  };
}

describe('enumerateEligibleCandidates', () => {
  it('everything is eligible against an empty history', () => {
    const history = buildHistoryView([], 'campaign-1', 0);
    const result = enumerateEligibleCandidates(catalog, 't1', history);
    expect(result.eligible.map((c) => c.probeId).sort()).toEqual(['p1:s1', 'p2:s1', 'p3:s1']);
    expect(result.eligible.every((c) => c.targetId === 't1')).toBe(true);
  });

  it('excludes a probe that reached maxAttemptsPerProbe', () => {
    const history = buildHistoryView([event(0, 't1', 'p1:s1', 'RESISTANT')], 'campaign-1', 1);
    const result = enumerateEligibleCandidates(catalog, 't1', history, { maxAttemptsPerProbe: 1, excludeConfirmedVulnerable: true });
    expect(result.eligible.some((c) => c.probeId === 'p1:s1')).toBe(false);
    expect(result.excludedReasons['p1:s1']).toContain('max-attempts-reached');
  });

  it('excludes a confirmed-vulnerable probe when the policy says so', () => {
    const history = buildHistoryView([event(0, 't1', 'p2:s1', 'VULNERABLE')], 'campaign-1', 1);
    const result = enumerateEligibleCandidates(catalog, 't1', history, { maxAttemptsPerProbe: 5, excludeConfirmedVulnerable: true });
    expect(result.eligible.some((c) => c.probeId === 'p2:s1')).toBe(false);
    expect(result.excludedReasons['p2:s1']).toBe('already-confirmed-vulnerable');
  });

  it('mandatory probes are always eligible, even past max attempts or after confirmation', () => {
    const history = buildHistoryView(
      [event(0, 't1', 'p3:s1', 'VULNERABLE'), event(1, 't1', 'p3:s1', 'VULNERABLE'), event(2, 't1', 'p3:s1', 'VULNERABLE')],
      'campaign-1',
      3,
    );
    const result = enumerateEligibleCandidates(catalog, 't1', history, { maxAttemptsPerProbe: 1, excludeConfirmedVulnerable: true });
    expect(result.eligible.some((c) => c.probeId === 'p3:s1' && c.mandatory)).toBe(true);
  });

  it('the default policy allows exactly one attempt per non-mandatory probe', () => {
    expect(DEFAULT_ELIGIBILITY_POLICY.maxAttemptsPerProbe).toBe(1);
  });

  it('a probe already confirmed VULNERABLE against Target A remains eligible against Target B — the exact bug this phase fixes', () => {
    const history = buildHistoryView(
      [event(0, 't-A', 'p1:s1', 'VULNERABLE'), event(1, 't-A', 'p2:s1', 'RESISTANT')],
      'campaign-1',
      2,
    );
    const targetA = enumerateEligibleCandidates(catalog, 't-A', history, { maxAttemptsPerProbe: 1, excludeConfirmedVulnerable: true });
    const targetB = enumerateEligibleCandidates(catalog, 't-B', history, { maxAttemptsPerProbe: 1, excludeConfirmedVulnerable: true });

    expect(targetA.eligible.some((c) => c.probeId === 'p1:s1')).toBe(false); // correctly excluded for A
    expect(targetA.eligible.some((c) => c.probeId === 'p2:s1')).toBe(false); // correctly excluded for A
    expect(targetB.eligible.some((c) => c.probeId === 'p1:s1')).toBe(true); // never ran against B — must stay eligible
    expect(targetB.eligible.some((c) => c.probeId === 'p2:s1')).toBe(true);
  });

  describe('blocksEligibility (ARCH_CLAUDE_TRANSFER.md §2.5)', () => {
    it('blocks exactly AUTHORIZATION_DENIED, CAPABILITY_UNSUPPORTED, and UNKNOWN_EFFECT_OUTCOME', () => {
      const blocking: TerminalReason[] = ['AUTHORIZATION_DENIED', 'CAPABILITY_UNSUPPORTED', 'UNKNOWN_EFFECT_OUTCOME'];
      const nonBlocking: TerminalReason[] = [
        'COMPLETED',
        'CANCELLED',
        'TIMED_OUT_BEFORE_EFFECT',
        'TARGET_UNAVAILABLE',
        'FAILED_BEFORE_EFFECT',
        'NORMALIZATION_FAILED',
        'STALE_LEASE_RESULT',
        'OBSERVATION_COMMITTED',
      ];
      for (const reason of blocking) expect(blocksEligibility(reason)).toBe(true);
      for (const reason of nonBlocking) expect(blocksEligibility(reason)).toBe(false);
    });
  });

  describe('settledAttemptsByReason gating (ARCH_CLAUDE_TRANSFER.md §2.5)', () => {
    it('a TARGET_UNAVAILABLE-only settled attempt does not exclude the probe — the exact bug this closes: contention is not a failed attempt', () => {
      const history = {
        ...buildHistoryView([], 'campaign-1', 0),
        settledAttemptsByReason: new Map([[targetProbeKey('t1', 'p1:s1'), { ...ZERO_COUNTS, TARGET_UNAVAILABLE: 3 }]]),
      };
      const result = enumerateEligibleCandidates(catalog, 't1', history);
      expect(result.eligible.some((c) => c.probeId === 'p1:s1')).toBe(true);
    });

    it('an AUTHORIZATION_DENIED settled attempt excludes the probe even with zero committed outcomes', () => {
      const history = {
        ...buildHistoryView([], 'campaign-1', 0),
        settledAttemptsByReason: new Map([[targetProbeKey('t1', 'p1:s1'), { ...ZERO_COUNTS, AUTHORIZATION_DENIED: 1 }]]),
      };
      const result = enumerateEligibleCandidates(catalog, 't1', history);
      expect(result.eligible.some((c) => c.probeId === 'p1:s1')).toBe(false);
      expect(result.excludedReasons['p1:s1']).toBe('settled-attempt-blocks-retry(AUTHORIZATION_DENIED)');
    });

    it('an UNKNOWN_EFFECT_OUTCOME settled attempt excludes the probe the same way', () => {
      const history = {
        ...buildHistoryView([], 'campaign-1', 0),
        settledAttemptsByReason: new Map([[targetProbeKey('t1', 'p1:s1'), { ...ZERO_COUNTS, UNKNOWN_EFFECT_OUTCOME: 1 }]]),
      };
      const result = enumerateEligibleCandidates(catalog, 't1', history);
      expect(result.eligible.some((c) => c.probeId === 'p1:s1')).toBe(false);
    });

    it('mandatory probes stay eligible even with a blocking settled attempt', () => {
      const history = {
        ...buildHistoryView([], 'campaign-1', 0),
        settledAttemptsByReason: new Map([[targetProbeKey('t1', 'p3:s1'), { ...ZERO_COUNTS, AUTHORIZATION_DENIED: 1 }]]),
      };
      const result = enumerateEligibleCandidates(catalog, 't1', history);
      expect(result.eligible.some((c) => c.probeId === 'p3:s1' && c.mandatory)).toBe(true);
    });
  });
});
