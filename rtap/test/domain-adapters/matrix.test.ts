import { describe, expect, it } from 'vitest';
import { evaluateAdapterAdmission, cellKey, DEFAULT_ADMISSION_OPTIONS, type CrossDomainMatrix } from '../../src/domain-adapters/matrix.js';

function matrix(cells: Record<string, number>, baseline: Record<string, number>): CrossDomainMatrix {
  return { adapterScores: new Map(Object.entries(cells)), baselineScores: new Map(Object.entries(baseline)) };
}

describe('evaluateAdapterAdmission', () => {
  it('admits a genuinely specialized adapter: gain on own domain, no gain elsewhere (the documented diagonal example)', () => {
    const m = matrix(
      {
        [cellKey('financial-adp', 'financial')]: 0.8,
        [cellKey('financial-adp', 'medical')]: 0.45,
      },
      { financial: 0.7, medical: 0.5 },
    );
    const result = evaluateAdapterAdmission(m, 'financial-adp', 'financial');
    expect(result.ownDomainGain).toBeCloseTo(0.1, 10);
    expect(result.offDomainGains).toHaveLength(1);
    expect(result.offDomainGains[0]!.domain).toBe('medical');
    expect(result.offDomainGains[0]!.gain).toBeCloseTo(-0.05, 10);
    expect(result.admitted).toBe(true);
  });

  it('rejects an adapter with insufficient own-domain gain', () => {
    const m = matrix({ [cellKey('a1', 'financial')]: 0.71 }, { financial: 0.7, medical: 0.5 });
    const result = evaluateAdapterAdmission(m, 'a1', 'financial');
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes.some((r) => r.startsWith('own-domain-gain-insufficient'))).toBe(true);
  });

  it('rejects a "free adapter" that improves every domain, not just its own', () => {
    const m = matrix(
      { [cellKey('a1', 'financial')]: 0.9, [cellKey('a1', 'medical')]: 0.9 },
      { financial: 0.7, medical: 0.5 },
    );
    const result = evaluateAdapterAdmission(m, 'a1', 'financial', DEFAULT_ADMISSION_OPTIONS);
    expect(result.freeAdapterClaim).toBe(true);
    expect(result.admitted).toBe(false);
  });

  it('rejects an adapter with missing evidence rather than assuming success', () => {
    const m = matrix({}, { financial: 0.7 });
    const result = evaluateAdapterAdmission(m, 'a1', 'financial');
    expect(result.admitted).toBe(false);
    expect(Number.isNaN(result.ownDomainGain)).toBe(true);
  });

  it('rejects when off-domain evidence is missing even if own-domain evidence exists', () => {
    const m = matrix({ [cellKey('a1', 'financial')]: 0.9 }, { financial: 0.7, medical: 0.5 });
    const result = evaluateAdapterAdmission(m, 'a1', 'financial');
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes.some((r) => r.includes('missing-evidence'))).toBe(true);
  });
});
