import { describe, expect, it } from 'vitest';
import { joinDispatchWithOutcomes, computeArmPerformance, evaluateABGate, DEFAULT_AB_GATE_OPTIONS } from '../../src/planner/ab.js';
import { targetProbeKey } from '../../src/features/history-view.js';
import type { DispatchLogEntry } from '../../src/planner/dispatch.js';

function entry(targetId: string, probeId: string, arm: DispatchLogEntry['arm']): DispatchLogEntry {
  return { assessmentRunId: 'run-1', runStepId: `step-${targetId}-${probeId}`, targetId, probeId, arm, policyVersion: 'policy-1', dispatchedAt: '2026-08-30T00:00:00.000Z' };
}

describe('joinDispatchWithOutcomes', () => {
  it('joins by (targetId, probeId) and drops entries with no known outcome', () => {
    const log = [entry('t1', 'p1', 'model'), entry('t1', 'p2', 'model'), entry('t1', 'p3', 'heuristic')];
    const outcomes = joinDispatchWithOutcomes(log, new Map([[targetProbeKey('t1', 'p1'), 0.8], [targetProbeKey('t1', 'p3'), 0.2]]));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.probeId).sort()).toEqual(['p1', 'p3']);
  });

  it('does not conflate the same probeId across two different targets', () => {
    const log = [entry('t-A', 'p1', 'model'), entry('t-B', 'p1', 'heuristic')];
    const outcomes = joinDispatchWithOutcomes(log, new Map([[targetProbeKey('t-A', 'p1'), 0.9]]));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ targetId: 't-A', probeId: 'p1', label: 0.9 });
  });
});

describe('computeArmPerformance', () => {
  it('computes mean label per arm', () => {
    const performance = computeArmPerformance([
      { arm: 'model', targetId: 't1', probeId: 'p1', label: 1 },
      { arm: 'model', targetId: 't1', probeId: 'p2', label: 0 },
      { arm: 'heuristic', targetId: 't1', probeId: 'p3', label: 0.5 },
    ]);
    const model = performance.find((p) => p.arm === 'model')!;
    expect(model.n).toBe(2);
    expect(model.meanLabel).toBe(0.5);
  });
});

describe('evaluateABGate', () => {
  it('returns HOLD when sample size is insufficient, never PROMOTE or DEMOTE on thin evidence', () => {
    const performance = [
      { arm: 'model' as const, n: 3, meanLabel: 0.9 },
      { arm: 'heuristic' as const, n: 3, meanLabel: 0.1 },
    ];
    const result = evaluateABGate(performance, DEFAULT_AB_GATE_OPTIONS);
    expect(result.recommendation).toBe('HOLD');
    expect(result.sufficientSample).toBe(false);
  });

  it('recommends PROMOTE when lift clears the threshold with sufficient sample', () => {
    const performance = [
      { arm: 'model' as const, n: 50, meanLabel: 0.7 },
      { arm: 'heuristic' as const, n: 50, meanLabel: 0.5 },
    ];
    const result = evaluateABGate(performance, DEFAULT_AB_GATE_OPTIONS);
    expect(result.recommendation).toBe('PROMOTE');
    expect(result.lift).toBeCloseTo(0.2, 10);
  });

  it('recommends DEMOTE when the model underperforms the control by the threshold', () => {
    const performance = [
      { arm: 'model' as const, n: 50, meanLabel: 0.3 },
      { arm: 'heuristic' as const, n: 50, meanLabel: 0.5 },
    ];
    const result = evaluateABGate(performance, DEFAULT_AB_GATE_OPTIONS);
    expect(result.recommendation).toBe('DEMOTE');
  });

  it('recommends HOLD when lift is within the neutral band', () => {
    const performance = [
      { arm: 'model' as const, n: 50, meanLabel: 0.51 },
      { arm: 'heuristic' as const, n: 50, meanLabel: 0.5 },
    ];
    const result = evaluateABGate(performance, DEFAULT_AB_GATE_OPTIONS);
    expect(result.recommendation).toBe('HOLD');
  });

  it('HOLDs when one arm has no data at all', () => {
    const result = evaluateABGate([{ arm: 'model' as const, n: 50, meanLabel: 0.9 }], DEFAULT_AB_GATE_OPTIONS);
    expect(result.recommendation).toBe('HOLD');
    expect(result.controlMeanLabel).toBeNull();
  });
});
