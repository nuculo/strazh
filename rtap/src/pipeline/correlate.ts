import type { ArtifactRef } from '../artifacts/store.js';

/**
 * Finding Correlator, Phase 1 policy. ARCHITECTURE.md §1: "Finding не является
 * синонимом каждого engine result" — this groups Observations for the same
 * (targetId, probeId) into one Finding.
 *
 * Verdict aggregation precedence (most to least certain-of-a-problem):
 *   VULNERABLE > UNVERIFIED > ERROR > RESISTANT
 * One VULNERABLE observation makes the Finding VULNERABLE regardless of how many
 * other attempts resisted. Absent that, any UNVERIFIED observation blocks a
 * confident RESISTANT claim — we do not average away missing evidence
 * (redteam.observation/unverified-data-is-not-a-positive-label extends to groups,
 * not just single observations). RESISTANT only when every observation in the
 * group graded RESISTANT. This is a Phase 1 policy; Phase 5's real Finding
 * Correlator (ARCHITECTURE.md §9) may refine it once there is production data to
 * validate against.
 */

export interface ObservationLike {
  readonly id: string;
  readonly targetId: string;
  readonly probeId: string;
  readonly verdict: string;
  /**
   * Optional content-addressed evidence references — never the raw bytes. Absent on
   * every pre-Phase-1 caller and on the Finding Correlator's own path (it groups by
   * verdict alone). Present, they are the only channel through which evidence reaches
   * a report: a renderer emits the `ref`, never what it points at
   * (redteam.artifact/public-report-never-inlines-payload). Shape mirrors
   * `ArtifactRef` from the Protected Artifact Store so the two never diverge.
   */
  readonly evidenceRefs?: readonly ArtifactRef[];
}

export interface Finding {
  readonly id: string;
  readonly schemaVersion: string;
  readonly targetId: string;
  readonly verdict: string;
  readonly observationIds: string[];
  readonly severity: string;
  readonly suppressed: boolean;
}

const VERDICT_PRECEDENCE = ['VULNERABLE', 'UNVERIFIED', 'ERROR', 'RESISTANT'] as const;

function aggregateVerdict(verdicts: readonly string[]): string {
  const present = new Set(verdicts);
  for (const candidate of VERDICT_PRECEDENCE) {
    if (present.has(candidate)) return candidate;
  }
  // Every observation had some other value — a schema-invalid verdict slipped through
  // upstream validation. Surface it rather than defaulting to a false RESISTANT.
  return 'UNVERIFIED';
}

// Placeholder until promptfoo's riskScoring.ts-equivalent lands — a real severity
// model is out of scope for Phase 1 (ARCHITECTURE.md §9 Phase 1 does not name it).
function severityFor(verdict: string): string {
  return verdict === 'VULNERABLE' ? 'high' : 'informational';
}

export function correlateFindings(observations: readonly ObservationLike[]): Finding[] {
  const groups = new Map<string, ObservationLike[]>();
  for (const obs of observations) {
    const key = `${obs.targetId}::${obs.probeId}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(obs);
    groups.set(key, bucket);
  }

  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    const verdict = aggregateVerdict(group.map((o) => o.verdict));
    findings.push({
      id: `finding-${key}`,
      schemaVersion: '1.0.0',
      targetId: group[0]!.targetId,
      verdict,
      observationIds: group.map((o) => o.id),
      severity: severityFor(verdict),
      suppressed: false,
    });
  }
  return findings;
}
