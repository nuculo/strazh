import { describe, expect, it } from 'vitest';
import { evaluateSwapTiming } from '../../src/domain-adapters/swap.js';
import { isOverlayOnly } from '../../src/domain-adapters/metadata.js';

describe('evaluateSwapTiming', () => {
  it('allows a run-boundary swap', () => {
    expect(evaluateSwapTiming({ domain: 'financial', newAdapterRef: 'a1', timing: 'RUN_BOUNDARY' }).allowed).toBe(true);
  });

  it('rejects a mid-run swap unconditionally', () => {
    const result = evaluateSwapTiming({ domain: 'financial', newAdapterRef: 'a1', timing: 'MID_RUN' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('state-invariance laws');
  });
});

describe('isOverlayOnly', () => {
  it('true when reassignEvery is 0', () => {
    expect(isOverlayOnly({ adapterRef: 'a1', domain: 'financial', parentCoreRef: 'core-1', reassignEvery: 0 })).toBe(true);
  });

  it('false when reassignEvery is positive — that changes core identity', () => {
    expect(isOverlayOnly({ adapterRef: 'a1', domain: 'financial', parentCoreRef: 'core-1', reassignEvery: 5 })).toBe(false);
  });
});
