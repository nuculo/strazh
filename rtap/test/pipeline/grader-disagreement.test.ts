import { describe, expect, it } from 'vitest';
import { validate } from '../../src/schemas/index.js';
import { computeGraderDisagreement, type GradedObservation } from '../../src/pipeline/grader-disagreement.js';

const world = { worldGeneration: 0, worldEpoch: 10 };

describe('computeGraderDisagreement', () => {
  it('reports no-graded-evidence when nothing graded ran', () => {
    const observations: GradedObservation[] = [{ id: 'o1', verdict: 'UNVERIFIED', engineId: 'promptfoo', graderRan: false }];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes).toEqual(['no-graded-evidence']);
  });

  it('reports single-grader-only when every graded observation comes from the same engine', () => {
    const observations: GradedObservation[] = [
      { id: 'o1', verdict: 'VULNERABLE', engineId: 'promptfoo', graderRan: true },
      { id: 'o2', verdict: 'RESISTANT', engineId: 'promptfoo', graderRan: true },
    ];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes).toEqual(['single-grader-only']);
  });

  it('reports zero disagreement when distinct graders unanimously agree', () => {
    const observations: GradedObservation[] = [
      { id: 'o1', verdict: 'VULNERABLE', engineId: 'promptfoo', graderRan: true },
      { id: 'o2', verdict: 'VULNERABLE', engineId: 'duo-llm', graderRan: true },
    ];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    expect(signal.value).toBe(0);
    expect(signal.kind).toBe('GRADER_DISAGREEMENT');
  });

  it('reports a positive disagreement score when distinct graders produce different verdicts on the same (target, probe)', () => {
    const observations: GradedObservation[] = [
      { id: 'o1', verdict: 'VULNERABLE', engineId: 'promptfoo', graderRan: true },
      { id: 'o2', verdict: 'RESISTANT', engineId: 'duo-llm', graderRan: true },
    ];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    expect(signal.value).toBeGreaterThan(0);
    expect(signal.reasonCodes.sort()).toEqual(['RESISTANT:1', 'VULNERABLE:1']);
  });

  it('excludes UNVERIFIED and ungraded observations from the comparison entirely', () => {
    const observations: GradedObservation[] = [
      { id: 'o1', verdict: 'VULNERABLE', engineId: 'promptfoo', graderRan: true },
      { id: 'o2', verdict: 'VULNERABLE', engineId: 'duo-llm', graderRan: true },
      { id: 'o3', verdict: 'UNVERIFIED', engineId: 'duo-static', graderRan: false },
    ];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    expect(signal.value).toBe(0); // unanimous among the two graded ones; o3 contributes nothing
    expect(signal.evidenceObservationIds.sort()).toEqual(['o1', 'o2']);
  });

  it('a 2-of-3 majority produces a fractional disagreement score, not a binary one', () => {
    const observations: GradedObservation[] = [
      { id: 'o1', verdict: 'VULNERABLE', engineId: 'promptfoo', graderRan: true },
      { id: 'o2', verdict: 'VULNERABLE', engineId: 'duo-llm', graderRan: true },
      { id: 'o3', verdict: 'RESISTANT', engineId: 'duo-static', graderRan: true },
    ];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    expect(signal.value).toBeCloseTo(1 / 3, 5);
  });

  it('produces a schema-valid FrozenSignal', () => {
    const observations: GradedObservation[] = [
      { id: 'o1', verdict: 'VULNERABLE', engineId: 'promptfoo', graderRan: true },
      { id: 'o2', verdict: 'RESISTANT', engineId: 'duo-llm', graderRan: true },
    ];
    const signal = computeGraderDisagreement('target-1', 'probe-1', observations, world);
    const check = validate('rtap:frozen-signal', signal);
    expect(check.valid, check.errors.join('; ')).toBe(true);
  });
});
