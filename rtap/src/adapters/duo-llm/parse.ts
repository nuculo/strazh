import { UNGRADED_SENTINEL, type DuoLlmRedteamReport, type DuoLlmTestResult } from './types.js';

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
    readonly engineId: 'duo-llm';
    readonly engineVersion: string;
    readonly adapterVersion: string;
    readonly schemaVersion: string;
    readonly nativeRunId: string;
    readonly nativeResultId: string;
    readonly graderKind: 'deterministic-verifier' | 'defaulted-pass';
    readonly graderVersion: null;
    readonly capabilitySnapshotRef: null;
    /** Always true — see module doc comment: strategy/domain input is provably ignored for every attack, not just some. */
    readonly configIgnored: true;
  };
}

function probeIdFor(attack: DuoLlmTestResult['attack']): string {
  return `${attack.plugin_id}:${attack.strategy_id ?? 'none'}`;
}

function wasGraded(result: DuoLlmTestResult): boolean {
  return result.grade.reason !== UNGRADED_SENTINEL;
}

/**
 * Anti-Corruption Layer: duo-agents' native TestResult -> RTAP Observation.
 *
 * `configIgnored: true` unconditionally, on every result, not only the ones that
 * happen to request a strategy or domain — `--strategies`/`--domains` are silently
 * ignored by `run_redteam()` for every attack (see types.ts's doc comment; verified
 * independently against a real captured report, not only against the upstream
 * wiki's own audit). `domain/verdict.ts`'s `deriveVerdict()` already treats
 * `configIgnored` as an unconditional UNVERIFIED regardless of `graderKind` — this
 * ACL sets the verdict field to that same value directly rather than calling
 * `deriveVerdict()` at commit time, matching duo-static/parse.ts's convention, but
 * the value is exactly what that function would compute.
 *
 * `graderKind` is `'defaulted-pass'` when `grade.reason` is the literal
 * `UNGRADED_SENTINEL` duo-agents' own fallback emits — `grade.pass`/`grade.score`
 * are not a verdict on anything in that case (`training/dataset-exporter.ts`
 * already excludes `defaulted-pass` observations from training data for exactly
 * this reason). Otherwise `'deterministic-verifier'`: one of the four real graders
 * ran (substring/keyword counting — not an LLM judge, not human review), and its
 * `score` survives as a `duo`-namespaced NativeMetric (never averaged with
 * promptfoo/duo-static/frozen scores, ARCHITECTURE.md §6) — omitted entirely for
 * `defaulted-pass` results, since a constant 1.0 there measures nothing.
 */
export function parseDuoLlmTestResult(result: DuoLlmTestResult, index: number, report: DuoLlmRedteamReport, ctx: ParseContext): ParsedObservation {
  const nativeResultId = `${report.id}-${index}`;
  const graded = wasGraded(result);

  return {
    id: `obs-duo-llm-${nativeResultId}`,
    schemaVersion: '1.0.0',
    targetId: ctx.targetId,
    probeId: probeIdFor(result.attack),
    assessmentRunId: ctx.assessmentRunId,
    verdict: 'UNVERIFIED',
    evidenceRefs: [
      { ref: `duo-llm:${report.id}:${index}:prompt`, kind: 'payload' },
      { ref: `duo-llm:${report.id}:${index}:response`, kind: 'response' },
      { ref: `duo-llm:${report.id}:report`, kind: 'native-report' },
    ],
    nativeMetrics: graded ? [{ namespace: 'duo', name: 'grade-score', value: result.grade.score }] : [],
    featureSnapshotRef: null,
    provenance: {
      engineId: 'duo-llm',
      engineVersion: ctx.engineVersion,
      adapterVersion: ctx.adapterVersion,
      schemaVersion: '1.0.0',
      nativeRunId: report.id,
      nativeResultId,
      graderKind: graded ? 'deterministic-verifier' : 'defaulted-pass',
      graderVersion: null,
      capabilitySnapshotRef: null,
      configIgnored: true,
    },
  };
}

export function parseDuoLlmRedteamReport(report: DuoLlmRedteamReport, ctx: ParseContext): ParsedObservation[] {
  return report.results.map((result, i) => parseDuoLlmTestResult(result, i, report, ctx));
}
