import type { DuoStaticFinding, DuoStaticScanResult, DuoSeverity } from './types.js';

export interface ParseContext {
  readonly assessmentRunId: string;
  readonly targetId: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
}

export interface ParsedObservation {
  readonly id: string;
  readonly schemaVersion: string;
  readonly targetId: string;
  readonly probeId: string;
  readonly assessmentRunId: string;
  readonly verdict: 'UNVERIFIED';
  readonly evidenceRefs: { ref: string; kind: string }[];
  readonly nativeMetrics: { namespace: 'duo'; name: string; value: number }[];
  readonly featureSnapshotRef: null;
  readonly provenance: {
    readonly engineId: 'duo-static';
    readonly engineVersion: string;
    readonly adapterVersion: string;
    readonly schemaVersion: string;
    readonly nativeRunId: string;
    readonly nativeResultId: string;
    readonly graderKind: 'none';
    readonly graderVersion: null;
    readonly capabilitySnapshotRef: null;
    readonly configIgnored: false;
  };
}

const SEVERITY_RANK: Record<DuoSeverity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1, Info: 0 };

function probeIdFor(finding: DuoStaticFinding): string {
  return `${finding.plugin}:${finding.cwe ?? 'no-cwe'}`;
}

/**
 * Anti-Corruption Layer: duo-agents' native Finding -> RTAP Observation.
 *
 * Verdict is always UNVERIFIED, deliberately — not a simplification but a direct
 * consequence of what the tool actually does. wiki/Arch_duo-agents/ARCHITECTURE.md
 * documents the scan plugins as line-regex substring matching (no AST, no taint
 * analysis despite README claims) with a routing bug that makes even *absence* of a
 * finding unreliable evidence of safety (MoeRouter's Top-6-of-8 selection). There is
 * no grader and no confirmation step — a raw pattern match is a candidate for
 * review, not a graded result, the same principle deriveVerdict() already encodes
 * for a missing promptfoo gradingResult (Phase 1). This is never VULNERABLE and
 * never RESISTANT; treating a regex hit as either would be exactly the "ungraded
 * becomes a positive/negative label" mistake the domain-safety laws forbid.
 *
 * Native severity is not discarded — it survives as a `duo` namespaced
 * NativeMetric (never averaged with promptfoo/frozen scores, ARCHITECTURE.md §6),
 * since redteam.observation/every-observation-has-provenance's sibling schema
 * (Finding) currently derives severity from verdict alone (Phase 1's
 * `severityFor()`) and would otherwise collapse every duo-static signal to
 * "informational" — a real, open gap, not silently hidden: see README.
 */
export function parseDuoStaticFinding(finding: DuoStaticFinding, index: number, scan: DuoStaticScanResult, ctx: ParseContext): ParsedObservation {
  const nativeResultId = `${scan.id}-${index}`;
  return {
    id: `obs-duo-static-${nativeResultId}`,
    schemaVersion: '1.0.0',
    targetId: ctx.targetId,
    probeId: probeIdFor(finding),
    assessmentRunId: ctx.assessmentRunId,
    verdict: 'UNVERIFIED',
    evidenceRefs: [
      { ref: `duo-static:${scan.id}:${finding.file}:${finding.line ?? 'no-line'}`, kind: 'snippet' },
      { ref: `duo-static:${scan.id}:report`, kind: 'native-report' },
    ],
    nativeMetrics: [{ namespace: 'duo', name: 'severity', value: SEVERITY_RANK[finding.severity] }],
    featureSnapshotRef: null,
    provenance: {
      engineId: 'duo-static',
      engineVersion: ctx.engineVersion,
      adapterVersion: ctx.adapterVersion,
      schemaVersion: '1.0.0',
      nativeRunId: scan.id,
      nativeResultId,
      graderKind: 'none',
      graderVersion: null,
      capabilitySnapshotRef: null,
      configIgnored: false,
    },
  };
}

export function parseDuoStaticScan(scan: DuoStaticScanResult, ctx: ParseContext): ParsedObservation[] {
  return scan.findings.map((finding, i) => parseDuoStaticFinding(finding, i, scan, ctx));
}
