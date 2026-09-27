import { describe, expect, it } from 'vitest';
import { validate } from '../../src/schemas/index.js';
import { buildHistoryView } from '../../src/features/history-view.js';
import { compileObservationFeatures } from '../../src/features/observation-compiler.js';
import { compileCandidateFeatures } from '../../src/features/candidate-compiler.js';
import { COORD } from '../../src/features/coordinates.js';
import { MISSING } from '../../src/features/missing.js';

const emptyHistory = buildHistoryView([], 'campaign-1', 0);

describe('compileObservationFeatures', () => {
  it('produces a schema-valid OBSERVATION snapshot', () => {
    const snapshot = compileObservationFeatures(
      {
        id: 'obs-1',
        targetId: 't1',
        probeId: 'prompt-injection:base64',
        verdict: 'VULNERABLE',
        provenance: { engineId: 'promptfoo', graderKind: 'llm-judge', configIgnored: false },
      },
      emptyHistory,
    );
    const check = validate('rtap:feature-snapshot', snapshot);
    expect(check.valid, check.errors.join('; ')).toBe(true);
    expect(snapshot.featureView).toBe('OBSERVATION');
    expect(snapshot.sourceObservationId).toBe('obs-1');
    expect(snapshot.candidateProbeId).toBeNull();
  });

  it('is deterministic: the same inputs always produce the same vector', () => {
    const input = {
      id: 'obs-1',
      targetId: 't1',
      probeId: 'p1:s1',
      verdict: 'RESISTANT',
      provenance: { engineId: 'promptfoo', graderKind: 'llm-judge', configIgnored: false },
    };
    const a = compileObservationFeatures(input, emptyHistory);
    const b = compileObservationFeatures(input, emptyHistory);
    expect(a.vector).toEqual(b.vector);
  });

  it('a VULNERABLE verdict scores higher on the grading coordinate than a RESISTANT one', () => {
    const base = { id: 'obs-1', targetId: 't1', probeId: 'p1:s1', provenance: { engineId: 'promptfoo', graderKind: 'llm-judge', configIgnored: false } };
    const vuln = compileObservationFeatures({ ...base, verdict: 'VULNERABLE' }, emptyHistory);
    const resist = compileObservationFeatures({ ...base, verdict: 'RESISTANT' }, emptyHistory);
    const scoreIdx = COORD.GRADING.start + 2;
    expect(vuln.vector[scoreIdx]).toBeGreaterThan(resist.vector[scoreIdx]!);
  });

  it('ERROR leaves the grading score coordinate MISSING rather than a false low score', () => {
    const snapshot = compileObservationFeatures(
      { id: 'obs-1', targetId: 't1', probeId: 'p1:s1', verdict: 'ERROR', provenance: { engineId: 'promptfoo', graderKind: 'none', configIgnored: false } },
      emptyHistory,
    );
    expect(snapshot.vector[COORD.GRADING.start + 2]).toBe(MISSING);
  });
});

describe('compileCandidateFeatures', () => {
  it('produces a schema-valid CANDIDATE snapshot', () => {
    const snapshot = compileCandidateFeatures(
      { targetId: 't1', probe: { probeId: 'prompt-injection:base64' }, budget: { targetCallsUsed: 10, targetCallsBudget: 100 } },
      emptyHistory,
    );
    const check = validate('rtap:feature-snapshot', snapshot);
    expect(check.valid, check.errors.join('; ')).toBe(true);
    expect(snapshot.featureView).toBe('CANDIDATE');
    expect(snapshot.candidateProbeId).toBe('prompt-injection:base64');
    expect(snapshot.sourceObservationId).toBeNull();
  });

  it('two strategies of the same vulnerability class get distinct PROBE_AND_STRATEGY coordinates (regression test: this coordinate was previously a useless constant)', () => {
    const base64 = compileCandidateFeatures({ targetId: 't1', probe: { probeId: 'prompt-injection:base64' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory);
    const multiTurn = compileCandidateFeatures({ targetId: 't1', probe: { probeId: 'prompt-injection:multi-turn' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory);
    const group = COORD.PROBE_AND_STRATEGY;
    const base64Slice = base64.vector.slice(group.start, group.start + group.count);
    const multiTurnSlice = multiTurn.vector.slice(group.start, group.start + group.count);
    expect(base64Slice).not.toEqual(multiTurnSlice);
    // Specifically: the vulnClass coordinate (offset 0) must be identical (same
    // class), while strategy (offset 1) and the joint pair (offset 2) must differ.
    expect(base64.vector[group.start + 0]).toBe(multiTurn.vector[group.start + 0]);
    expect(base64.vector[group.start + 1]).not.toBe(multiTurn.vector[group.start + 1]);
    expect(base64.vector[group.start + 2]).not.toBe(multiTurn.vector[group.start + 2]);
  });

  it('encodes remaining budget fraction, saturating at 0 and 1', () => {
    const full = compileCandidateFeatures({ targetId: 't1', probe: { probeId: 'p1:s1' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory);
    const exhausted = compileCandidateFeatures(
      { targetId: 't1', probe: { probeId: 'p1:s1' }, budget: { targetCallsUsed: 100, targetCallsBudget: 100 } },
      emptyHistory,
    );
    const budgetIdx = COORD.CAMPAIGN_HISTORY.start + 4;
    expect(full.vector[budgetIdx]).toBe(1);
    expect(exhausted.vector[budgetIdx]).toBe(0);
  });

  it('the same probeId gets the same PROBE_AND_STRATEGY coordinates in both compilers (shared a priori vocabulary)', () => {
    const candidate = compileCandidateFeatures({ targetId: 't1', probe: { probeId: 'p1:s1' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory);
    const observation = compileObservationFeatures(
      { id: 'obs-1', targetId: 't1', probeId: 'p1:s1', verdict: 'VULNERABLE', provenance: { engineId: 'promptfoo', graderKind: 'llm-judge', configIgnored: false } },
      emptyHistory,
    );
    const group = COORD.PROBE_AND_STRATEGY;
    const candidateSlice = candidate.vector.slice(group.start, group.start + group.count);
    const observationSlice = observation.vector.slice(group.start, group.start + group.count);
    expect(candidateSlice).toEqual(observationSlice);
  });

  it('reflects prior history: a probe already confirmed VULNERABLE shows up as such for a later candidate', () => {
    const history = buildHistoryView(
      [
        {
          schemaVersion: '1.0.0',
          eventId: 'e1',
          campaignId: 'campaign-1',
          assessmentRunId: 'run-1',
          sequence: 0,
          occurredAt: '2026-08-30T00:00:00.000Z',
          committedAt: '2026-08-30T00:00:00.000Z',
          eventType: 'VulnerabilityObserved',
          sourceObservationIds: [],
          featureSnapshotRef: null,
          taxonomySnapshotRef: null,
          payload: { targetId: 't1', probeId: 'p1:s1', verdict: 'VULNERABLE' },
        },
      ],
      'campaign-1',
      1,
    );
    const candidate = compileCandidateFeatures({ targetId: 't1', probe: { probeId: 'p1:s1' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, history);
    expect(candidate.vector[COORD.CAMPAIGN_HISTORY.start + 2]).toBe(1); // confirmedFindingTargetProbes.has
  });
});
