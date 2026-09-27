import type { Finding, ObservationLike } from './correlate.js';

/**
 * What was planned versus what actually resolved (ARCH_CLAUDE_TRANSFER.md §2.4).
 * Built from `CampaignWorldState.scheduledUnresolved`, which the reducer maintains
 * from `ProbeScheduled` minus the four resolving event types.
 *
 * Optional on `ReportInput` on purpose: a caller that has no world to consult (every
 * pre-Phase-4 path, and the Phase 1 vertical slice) still gets a report, and gets it
 * marked `UNKNOWN` rather than silently presented as complete. Absence of coverage
 * information and proof of full coverage must never look the same — which is the
 * whole defect this closes.
 */
export interface CoverageInput {
  readonly scheduled: number;
  /** `scheduledProbeKey` values still outstanding — `targetProbeKey()`-encoded pairs. */
  readonly unresolved: readonly string[];
}

/** `COMPLETE`/`INCOMPLETE` are Observed evidence (every scheduled probe's resolution was actually checked); `UNKNOWN` is Missing evidence — see rtap/README.md's "Evidence levels: Observed / Inferred / Missing". */
export type CoverageStatus = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';

export interface CoverageReport {
  readonly status: CoverageStatus;
  readonly scheduled: number | null;
  readonly resolved: number | null;
  readonly unresolved: readonly string[];
}

export interface ReportInput {
  readonly assessmentRunId: string;
  readonly generatedAt: string;
  readonly observations: readonly ObservationLike[];
  readonly findings: readonly Finding[];
  readonly coverage?: CoverageInput;
}

export interface JsonReport {
  readonly schemaVersion: string;
  readonly assessmentRunId: string;
  readonly generatedAt: string;
  readonly summary: {
    readonly totalObservations: number;
    /**
     * Count of correlated result groups (one per (target, probe)). A "finding" here
     * is an evaluated result group, NOT necessarily a vulnerability — see
     * `vulnerabilities`/`resistant`/`unverified`/`errors` for the security-meaningful
     * split. `totalFindings === vulnerabilities + resistant + unverified + errors`.
     */
    readonly totalFindings: number;
    readonly byVerdict: Record<string, number>;
    /** Findings whose verdict is VULNERABLE — the only category that is an actual weakness. */
    readonly vulnerabilities: number;
    /** Findings whose verdict is RESISTANT — the target held. */
    readonly resistant: number;
    /** Findings whose verdict is UNVERIFIED — evaluated but no trustworthy signal. */
    readonly unverified: number;
    /** Findings whose verdict is ERROR — the probe could not evaluate the target. */
    readonly errors: number;
  };
  /**
   * The denominator every count above is implicitly a numerator of. Mandatory in the
   * output even when the input carried none — a report without it would be exactly
   * the artifact this field exists to prevent.
   */
  readonly coverage: CoverageReport;
  readonly findings: readonly Finding[];
}

/**
 * A report a caller must not present as an assessment result. Returned instead of
 * thrown because incomplete coverage is a *legitimate operational state* (a run still
 * in flight, an adapter that died mid-sweep), not a programming error — and because a
 * caller that wants the partial data can still read it off `report`.
 */
export type ReportResult =
  | { readonly ok: true; readonly report: JsonReport }
  | { readonly ok: false; readonly reason: 'UNRESOLVED_COVERAGE' | 'UNKNOWN_COVERAGE'; readonly report: JsonReport; readonly detail: string };

function countByVerdict(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.verdict] = (counts[f.verdict] ?? 0) + 1;
  }
  return counts;
}

function buildCoverage(input: ReportInput): CoverageReport {
  if (!input.coverage) {
    return { status: 'UNKNOWN', scheduled: null, resolved: null, unresolved: [] };
  }
  const unresolved = [...input.coverage.unresolved];
  return {
    status: unresolved.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
    scheduled: input.coverage.scheduled,
    resolved: input.coverage.scheduled - unresolved.length,
    unresolved,
  };
}

export function buildJsonReport(input: ReportInput): JsonReport {
  const byVerdict = countByVerdict(input.findings);
  return {
    schemaVersion: '1.0.0',
    assessmentRunId: input.assessmentRunId,
    generatedAt: input.generatedAt,
    summary: {
      totalObservations: input.observations.length,
      totalFindings: input.findings.length,
      byVerdict,
      vulnerabilities: byVerdict.VULNERABLE ?? 0,
      resistant: byVerdict.RESISTANT ?? 0,
      unverified: byVerdict.UNVERIFIED ?? 0,
      errors: byVerdict.ERROR ?? 0,
    },
    coverage: buildCoverage(input),
    findings: input.findings,
  };
}

/**
 * The report-building entry point that can say no. `buildJsonReport()` stays total
 * and unchanged in shape for every existing caller; this wraps it with the judgement
 * those callers were making implicitly and wrongly — that a report with no findings
 * means the target held up, rather than that nothing ran.
 */
export function buildAssessmentReport(input: ReportInput): ReportResult {
  const report = buildJsonReport(input);
  if (report.coverage.status === 'INCOMPLETE') {
    return {
      ok: false,
      reason: 'UNRESOLVED_COVERAGE',
      report,
      detail: `${report.coverage.unresolved.length} of ${report.coverage.scheduled} scheduled probes never resolved — this report describes a partial run, not an assessment result`,
    };
  }
  if (report.coverage.status === 'UNKNOWN') {
    return {
      ok: false,
      reason: 'UNKNOWN_COVERAGE',
      report,
      detail: 'no coverage information was supplied, so completeness cannot be claimed — pass CampaignWorldState.scheduledUnresolved to establish it',
    };
  }
  return { ok: true, report };
}

export function buildMarkdownReport(input: ReportInput): string {
  const json = buildJsonReport(input);
  const s = json.summary;
  const cov = json.coverage;
  const lines: string[] = [];
  lines.push(`# RTAP Assessment Report`);
  lines.push('');
  lines.push(`- Assessment run: \`${input.assessmentRunId}\``);
  lines.push(`- Generated at: ${input.generatedAt}`);
  lines.push(`- Coverage: ${cov.status}${cov.scheduled !== null ? ` (${cov.resolved ?? 0}/${cov.scheduled} probes resolved)` : ''}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  // Distinguish evaluated results from vulnerabilities explicitly — "findings" is a
  // correlated result group, not a synonym for "vulnerability".
  lines.push(`- Evaluated results (observations): ${s.totalObservations}`);
  lines.push(`- Result groups (findings): ${s.totalFindings}`);
  lines.push(`- **Vulnerabilities (VULNERABLE): ${s.vulnerabilities}**`);
  lines.push(`- Resistant (target held): ${s.resistant}`);
  lines.push(`- Unverified (no trustworthy signal): ${s.unverified}`);
  lines.push(`- Errors (probe could not evaluate): ${s.errors}`);
  lines.push('');
  if (s.vulnerabilities > 0) {
    lines.push('## Vulnerabilities');
    lines.push('');
    lines.push('| ID | Target | Probe | Severity | Observations |');
    lines.push('|---|---|---|---|---|');
    for (const f of input.findings.filter((f) => f.verdict === 'VULNERABLE')) {
      lines.push(`| ${f.id} | ${f.targetId} | ${probeOf(f)} | ${f.severity} | ${f.observationIds.length} |`);
    }
    lines.push('');
  } else {
    lines.push('_No vulnerabilities found._');
    lines.push('');
  }
  lines.push('## All results');
  lines.push('');
  lines.push('| ID | Target | Probe | Verdict | Severity | Observations |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of input.findings) {
    lines.push(`| ${f.id} | ${f.targetId} | ${probeOf(f)} | ${f.verdict} | ${f.severity} | ${f.observationIds.length} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The probe id encoded in a Finding id (`finding-${targetId}::${probeId}`). */
function probeOf(finding: Finding): string {
  const marker = finding.id.indexOf('::');
  return marker === -1 ? '(unknown)' : finding.id.slice(marker + 2);
}
