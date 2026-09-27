import { describe, expect, it } from 'vitest';
import { attemptTransition, authorityFor } from '../../src/promotion/types.js';

describe('attemptTransition', () => {
  it('OFF -> SHADOW on MODEL_ADMITTED', () => {
    const result = attemptTransition('OFF', 'MODEL_ADMITTED');
    expect(result).toEqual({ allowed: true, from: 'OFF', to: 'SHADOW' });
  });

  it('SHADOW -> EXPERIMENTAL on OFFLINE_AND_SHADOW_GATES_PASSED', () => {
    expect(attemptTransition('SHADOW', 'OFFLINE_AND_SHADOW_GATES_PASSED').to).toBe('EXPERIMENTAL');
  });

  it('EXPERIMENTAL -> CALIBRATED on AB_GATES_PASSED', () => {
    expect(attemptTransition('EXPERIMENTAL', 'AB_GATES_PASSED').to).toBe('CALIBRATED');
  });

  it('CALIBRATED -> SHADOW on DRIFT_OR_QUALITY_REGRESSION', () => {
    expect(attemptTransition('CALIBRATED', 'DRIFT_OR_QUALITY_REGRESSION').to).toBe('SHADOW');
  });

  it('EXPERIMENTAL -> SHADOW on SAFETY_OR_COVERAGE_REGRESSION', () => {
    expect(attemptTransition('EXPERIMENTAL', 'SAFETY_OR_COVERAGE_REGRESSION').to).toBe('SHADOW');
  });

  it('SHADOW -> OFF on ARTIFACT_OR_SCHEMA_INVALID', () => {
    expect(attemptTransition('SHADOW', 'ARTIFACT_OR_SCHEMA_INVALID').to).toBe('OFF');
  });

  it('CALIBRATED -> OFF on INTEGRITY_OR_POLICY_FAILURE', () => {
    expect(attemptTransition('CALIBRATED', 'INTEGRITY_OR_POLICY_FAILURE').to).toBe('OFF');
  });

  it('rejects an undeclared transition instead of coercing it', () => {
    const result = attemptTransition('OFF', 'AB_GATES_PASSED');
    expect(result.allowed).toBe(false);
    expect(result.to).toBe('OFF'); // stays put, does not silently jump to CALIBRATED
  });

  it('rejects skipping a state (OFF cannot jump straight to CALIBRATED)', () => {
    expect(attemptTransition('OFF', 'AB_GATES_PASSED').allowed).toBe(false);
  });

  it('a model cannot self-promote: there is no event that both originates and is legal from every state', () => {
    // Sanity: MODEL_ADMITTED is only legal from OFF, not from any state a model
    // might claim to already be in.
    for (const state of ['SHADOW', 'EXPERIMENTAL', 'CALIBRATED'] as const) {
      expect(attemptTransition(state, 'MODEL_ADMITTED').allowed).toBe(false);
    }
  });
});

describe('authorityFor', () => {
  it('OFF grants no ranking and no influence', () => {
    expect(authorityFor('OFF')).toEqual({ rankAndLogCandidates: false, influencesRunStepCreation: false, boundedShare: false });
  });

  it('SHADOW ranks and logs but never influences RunStep creation', () => {
    const a = authorityFor('SHADOW');
    expect(a.rankAndLogCandidates).toBe(true);
    expect(a.influencesRunStepCreation).toBe(false);
  });

  it('EXPERIMENTAL influences with a bounded share', () => {
    const a = authorityFor('EXPERIMENTAL');
    expect(a.influencesRunStepCreation).toBe(true);
    expect(a.boundedShare).toBe(true);
  });

  it('CALIBRATED influences without the EXPERIMENTAL-specific bound (policy-limited instead)', () => {
    const a = authorityFor('CALIBRATED');
    expect(a.influencesRunStepCreation).toBe(true);
    expect(a.boundedShare).toBe(false);
  });
});
