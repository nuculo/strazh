import { describe, expect, it } from 'vitest';
import { validate } from '../../src/schemas/index.js';
import { compileCandidateFeatures } from '../../src/features/candidate-compiler.js';
import { buildHistoryView } from '../../src/features/history-view.js';
import { scoreCandidate } from '../../src/shadow/signal.js';
import { rankCandidates } from '../../src/shadow/rank.js';
import { heuristicBaseline } from '../../src/training/baselines/heuristic-baseline.js';

const emptyHistory = buildHistoryView([], 'campaign-1', 0);
const world = { worldGeneration: 1, worldEpoch: 42 };

function features(probeId: string) {
  return compileCandidateFeatures({ targetId: 't1', probe: { probeId }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory);
}

describe('scoreCandidate', () => {
  it('produces a schema-valid FrozenSignal', () => {
    const model = heuristicBaseline.fit([]);
    const signal = scoreCandidate(model, 'heuristic-v1', features('p1:s1'), world, 'SHADOW');
    const check = validate('rtap:frozen-signal', signal);
    expect(check.valid, check.errors.join('; ')).toBe(true);
  });

  it('carries the exact world position it was scored at', () => {
    const model = heuristicBaseline.fit([]);
    const signal = scoreCandidate(model, 'heuristic-v1', features('p1:s1'), world, 'SHADOW');
    expect(signal.worldGeneration).toBe(1);
    expect(signal.worldEpoch).toBe(42);
  });

  it('kind is always PROBE_UTILITY and quality reflects the caller-declared promotion state', () => {
    const model = heuristicBaseline.fit([]);
    const shadow = scoreCandidate(model, 'm1', features('p1:s1'), world, 'SHADOW');
    const experimental = scoreCandidate(model, 'm1', features('p1:s1'), world, 'EXPERIMENTAL');
    expect(shadow.kind).toBe('PROBE_UTILITY');
    expect(shadow.quality).toBe('SHADOW');
    expect(experimental.quality).toBe('EXPERIMENTAL');
  });
});

describe('rankCandidates', () => {
  it('ranks candidates in descending order of predicted utility, 1-based', () => {
    const model = { name: 'fixed', predict: (f: ReturnType<typeof features>) => (f.candidateProbeId === 'p2:s1' ? 10 : 1) };
    const result = rankCandidates(model, 'fixed', [features('p1:s1'), features('p2:s1'), features('p3:s1')], world, 'SHADOW');
    expect(result.ranked[0]!.probeId).toBe('p2:s1');
    expect(result.ranked[0]!.rank).toBe(1);
    expect(result.usedFallback).toBe(false);
  });

  it('handles an empty candidate list without error', () => {
    const model = heuristicBaseline.fit([]);
    const result = rankCandidates(model, 'heuristic', [], world, 'SHADOW');
    expect(result.ranked).toEqual([]);
  });

  it('every signal in the ranking validates against rtap:frozen-signal', () => {
    const model = heuristicBaseline.fit([]);
    const result = rankCandidates(model, 'heuristic', [features('p1:s1'), features('p2:s1')], world, 'SHADOW');
    for (const r of result.ranked) {
      expect(validate('rtap:frozen-signal', r.signal).valid).toBe(true);
    }
  });
});
