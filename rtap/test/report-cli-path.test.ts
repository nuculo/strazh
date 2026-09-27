import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../src/db/connection.js';
import { ObservationStore } from '../src/observations/store.js';
import { correlateFindings, type ObservationLike } from '../src/pipeline/correlate.js';
import { buildSarifReport } from '../src/pipeline/sarif.js';

/**
 * The data path the report CLI walks: committed Observations in a real store →
 * Findings → SARIF, with evidence refs surviving the round trip. The CLI shell
 * (report-cli.ts) is a thin production caller, untested directly like the other
 * per-module cli.ts shells; this covers the composition it wraps.
 */
const provenance = {
  engineId: 'promptfoo',
  engineVersion: '1.0',
  adapterVersion: '1.0',
  schemaVersion: '1.0.0',
  nativeRunId: 'nr1',
  nativeResultId: 'res1',
  graderKind: 'llm-judge' as const,
};

describe('report data path (store → SARIF)', () => {
  it('carries stored evidence refs into SARIF, never the bytes', () => {
    const db = openInMemoryDatabase();
    const store = new ObservationStore(db);
    store.put({
      id: 'obs-1',
      schemaVersion: '1.0.0',
      assessmentRunId: 'run-42',
      targetId: 't1',
      probeId: 'jailbreak',
      verdict: 'VULNERABLE',
      provenance,
      evidenceRefs: [{ ref: 'sha256:cafe', kind: 'payload' }],
    });
    store.put({
      id: 'obs-2',
      schemaVersion: '1.0.0',
      assessmentRunId: 'run-42',
      targetId: 't1',
      probeId: 'pii-leak',
      verdict: 'RESISTANT',
      provenance: { ...provenance, nativeResultId: 'res2' },
      evidenceRefs: [{ ref: 'sha256:feed', kind: 'trace' }],
    });

    const observations: ObservationLike[] = store.listByAssessmentRun('run-42').map((r) => ({
      id: r.id,
      targetId: r.targetId,
      probeId: r.probeId,
      verdict: r.verdict,
      evidenceRefs: r.evidenceRefs as ObservationLike['evidenceRefs'],
    }));
    const sarif = buildSarifReport(
      { assessmentRunId: 'run-42', generatedAt: '2026-09-04T00:00:00.000Z', observations, findings: correlateFindings(observations), coverage: { scheduled: 2, unresolved: [] } },
      { toolVersion: '0.0.0' },
    );

    expect(sarif.runs[0]!.results).toHaveLength(2);
    expect(sarif.runs[0]!.invocations[0]!.executionSuccessful).toBe(true);
    const vuln = sarif.runs[0]!.results.find((r) => r.ruleId === 'rtap.probe.jailbreak')!;
    expect(vuln.level).toBe('error');
    expect(vuln.relatedLocations.map((l) => l.physicalLocation!.artifactLocation.uri)).toEqual(['rtap-artifact:sha256:cafe']);
    expect(JSON.stringify(sarif)).not.toContain('provenance');
  });
});
