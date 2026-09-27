import { describe, expect, it } from 'vitest';
import { correlateFindings } from '../src/pipeline/correlate.js';

describe('correlateFindings', () => {
  it('groups observations by (targetId, probeId)', () => {
    const findings = correlateFindings([
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
      { id: 'o2', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
      { id: 'o3', targetId: 't1', probeId: 'p2', verdict: 'VULNERABLE' },
    ]);
    expect(findings).toHaveLength(2);
  });

  it('one VULNERABLE observation makes the whole Finding VULNERABLE', () => {
    const [finding] = correlateFindings([
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
      { id: 'o2', targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' },
    ]);
    expect(finding!.verdict).toBe('VULNERABLE');
    expect(finding!.observationIds).toEqual(['o1', 'o2']);
  });

  it('any UNVERIFIED observation blocks a confident RESISTANT, absent a VULNERABLE', () => {
    const [finding] = correlateFindings([
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
      { id: 'o2', targetId: 't1', probeId: 'p1', verdict: 'UNVERIFIED' },
    ]);
    expect(finding!.verdict).toBe('UNVERIFIED');
  });

  it('RESISTANT only when every observation in the group is RESISTANT', () => {
    const [finding] = correlateFindings([
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
      { id: 'o2', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
    ]);
    expect(finding!.verdict).toBe('RESISTANT');
    expect(finding!.severity).toBe('informational');
  });

  it('VULNERABLE findings get high severity as a Phase 1 placeholder', () => {
    const [finding] = correlateFindings([{ id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' }]);
    expect(finding!.severity).toBe('high');
  });
});
