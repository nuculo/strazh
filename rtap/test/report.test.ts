import { describe, expect, it } from 'vitest';
import { buildJsonReport, buildMarkdownReport } from '../src/pipeline/report.js';
import { correlateFindings } from '../src/pipeline/correlate.js';

const observations = [
  { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' },
  { id: 'o2', targetId: 't1', probeId: 'p2', verdict: 'RESISTANT' },
];
const findings = correlateFindings(observations);

describe('buildJsonReport', () => {
  it('summarizes counts by verdict', () => {
    const report = buildJsonReport({
      assessmentRunId: 'run-1',
      generatedAt: '2026-08-30T00:00:00.000Z',
      observations,
      findings,
    });
    expect(report.summary.totalFindings).toBe(2);
    expect(report.summary.byVerdict).toEqual({ VULNERABLE: 1, RESISTANT: 1 });
  });

  it('distinguishes vulnerabilities from resistant/unverified/error result groups', () => {
    const obs = [
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' },
      { id: 'o2', targetId: 't1', probeId: 'p2', verdict: 'RESISTANT' },
      { id: 'o3', targetId: 't1', probeId: 'p3', verdict: 'UNVERIFIED' },
      { id: 'o4', targetId: 't1', probeId: 'p4', verdict: 'ERROR' },
    ];
    const report = buildJsonReport({ assessmentRunId: 'run-1', generatedAt: '2026-08-30T00:00:00.000Z', observations: obs, findings: correlateFindings(obs) });
    expect(report.summary.totalFindings).toBe(4);
    expect(report.summary.vulnerabilities).toBe(1);
    expect(report.summary.resistant).toBe(1);
    expect(report.summary.unverified).toBe(1);
    expect(report.summary.errors).toBe(1);
    // The distinct categories partition the result groups.
    const s = report.summary;
    expect(s.vulnerabilities + s.resistant + s.unverified + s.errors).toBe(s.totalFindings);
  });
});

describe('buildMarkdownReport', () => {
  it('renders result tables, a distinct vulnerabilities section, and never conflates findings with vulnerabilities', () => {
    const md = buildMarkdownReport({
      assessmentRunId: 'run-1',
      generatedAt: '2026-08-30T00:00:00.000Z',
      observations,
      findings,
    });
    expect(md).toContain('# RTAP Assessment Report');
    // Explicit, distinct summary lines.
    expect(md).toContain('Vulnerabilities (VULNERABLE): 1');
    expect(md).toContain('Resistant (target held): 1');
    // The vulnerability appears in the Vulnerabilities section and the all-results table.
    expect(md).toContain('## Vulnerabilities');
    expect(md).toMatch(/\| finding-t1::p1 \| t1 \| p1 \| high \| 1 \|/);
    // The Vulnerabilities section lists only the VULNERABLE probe (p1), not the
    // RESISTANT one (p2). Slice the section between its header and the next header.
    const vulnSection = md.slice(md.indexOf('## Vulnerabilities'), md.indexOf('## All results'));
    expect(vulnSection).toContain('p1');
    expect(vulnSection).not.toContain('p2');
  });

  it('shows "No vulnerabilities found." when there are none', () => {
    const resistantOnly = [{ id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' }];
    const md = buildMarkdownReport({ assessmentRunId: 'run-1', generatedAt: '2026-08-30T00:00:00.000Z', observations: resistantOnly, findings: correlateFindings(resistantOnly) });
    expect(md).toContain('_No vulnerabilities found._');
    expect(md).toContain('Vulnerabilities (VULNERABLE): 0');
  });
});
