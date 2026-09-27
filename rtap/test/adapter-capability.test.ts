import { describe, expect, it } from 'vitest';
import { checkCapabilities, type EngineAdapterCapabilities } from '../src/adapters/capability.js';

describe('checkCapabilities', () => {
  const allTrue: EngineAdapterCapabilities = {
    realTargetProvider: true,
    strategiesConnected: true,
    mandatoryGrading: true,
    deterministicScoring: true,
  };
  const allFalse: EngineAdapterCapabilities = {
    realTargetProvider: false,
    strategiesConnected: false,
    mandatoryGrading: false,
    deterministicScoring: false,
  };

  it('permits when every required capability is declared', () => {
    const result = checkCapabilities(allTrue, ['realTargetProvider', 'mandatoryGrading']);
    expect(result).toEqual({ permitted: true, missing: [] });
  });

  it('rejects and names every missing capability, not just the first', () => {
    const result = checkCapabilities(allFalse, ['realTargetProvider', 'mandatoryGrading']);
    expect(result.permitted).toBe(false);
    expect(result.missing).toEqual(['realTargetProvider', 'mandatoryGrading']);
  });

  it('rejects on a single missing capability even when the rest are declared', () => {
    const partial: EngineAdapterCapabilities = { ...allTrue, deterministicScoring: false };
    const result = checkCapabilities(partial, ['realTargetProvider', 'deterministicScoring']);
    expect(result.permitted).toBe(false);
    expect(result.missing).toEqual(['deterministicScoring']);
  });

  it('permits trivially when nothing is required', () => {
    expect(checkCapabilities(allFalse, [])).toEqual({ permitted: true, missing: [] });
  });
});
