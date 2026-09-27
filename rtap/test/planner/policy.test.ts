import { describe, expect, it } from 'vitest';
import { validatePolicy, DEFAULT_EXPERIMENTAL_POLICY } from '../../src/planner/policy.js';

describe('validatePolicy', () => {
  it('accepts the default policy', () => {
    expect(() => validatePolicy(DEFAULT_EXPERIMENTAL_POLICY)).not.toThrow();
  });

  it('rejects explorationShare <= 0 — the exploration arm must never be configured away', () => {
    expect(() => validatePolicy({ ...DEFAULT_EXPERIMENTAL_POLICY, explorationShare: 0 })).toThrow(/never be configured away/);
  });

  it('rejects modelShareCap outside [0,1]', () => {
    expect(() => validatePolicy({ ...DEFAULT_EXPERIMENTAL_POLICY, modelShareCap: 1.5 })).toThrow();
  });

  it('rejects modelShareCap + explorationShare > 1', () => {
    expect(() => validatePolicy({ ...DEFAULT_EXPERIMENTAL_POLICY, modelShareCap: 0.9, explorationShare: 0.5 })).toThrow(/over-commits/);
  });

  it('rejects maxBatchSize < 1', () => {
    expect(() => validatePolicy({ ...DEFAULT_EXPERIMENTAL_POLICY, maxBatchSize: 0 })).toThrow();
  });
});
