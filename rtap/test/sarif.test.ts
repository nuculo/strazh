import { describe, expect, it } from 'vitest';
import { buildSarifReport } from '../src/pipeline/sarif.js';
import { validateSarifAgainstSchema } from '../src/pipeline/sarif-schema.js';
import { correlateFindings, type ObservationLike } from '../src/pipeline/correlate.js';

const observations: ObservationLike[] = [
  {
    id: 'o1',
    targetId: 't1',
    probeId: 'p1',
    verdict: 'VULNERABLE',
    evidenceRefs: [{ ref: 'sha256:aaa', kind: 'payload' }, { ref: 'sha256:bbb', kind: 'response' }],
  },
  { id: 'o2', targetId: 't1', probeId: 'p2', verdict: 'RESISTANT', evidenceRefs: [{ ref: 'sha256:ccc', kind: 'trace' }] },
  { id: 'o3', targetId: 't2', probeId: 'p1', verdict: 'UNVERIFIED' },
];
const findings = correlateFindings(observations);

function build(coverage?: { scheduled: number; unresolved: string[] }) {
  return buildSarifReport({
    assessmentRunId: 'run-1',
    generatedAt: '2026-09-04T00:00:00.000Z',
    observations,
    findings,
    ...(coverage ? { coverage } : {}),
  });
}

describe('buildSarifReport', () => {
  it('emits a valid SARIF 2.1.0 envelope', () => {
    const log = build();
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.tool.driver.name).toBe('RTAP');
    expect(log.runs[0]!.automationDetails.id).toBe('run-1');
    expect(log.runs[0]!.results).toHaveLength(findings.length);
  });

  it('maps verdict to a SARIF level+kind (only VULNERABLE carries a non-none level)', () => {
    const byV = new Map(build().runs[0]!.results.map((r) => [r.properties.verdict, r] as const));
    // VULNERABLE+high is the one vulnerability alert.
    expect(byV.get('VULNERABLE')!.level).toBe('error');
    expect(byV.get('VULNERABLE')!.kind).toBe('fail');
    // RESISTANT/UNVERIFIED are evaluated-but-not-a-vulnerability: SARIF requires a
    // non-fail result to carry level "none"; the outcome is carried by `kind`.
    expect(byV.get('RESISTANT')!.level).toBe('none');
    expect(byV.get('RESISTANT')!.kind).toBe('pass');
    expect(byV.get('UNVERIFIED')!.level).toBe('none');
    expect(byV.get('UNVERIFIED')!.kind).toBe('review');
  });

  it('declares one rule per distinct probe', () => {
    const ruleIds = build().runs[0]!.tool.driver.rules.map((r) => r.id).sort();
    expect(ruleIds).toEqual(['rtap.probe.p1', 'rtap.probe.p2']);
  });

  it('targets a logical location, never a file path', () => {
    const result = build().runs[0]!.results.find((r) => r.properties.verdict === 'VULNERABLE')!;
    expect(result.locations[0]!.logicalLocations![0]!.fullyQualifiedName).toBe('target:t1');
    expect(result.locations[0]!.physicalLocation).toBeUndefined();
  });

  it('surfaces evidence only as content-addressed references, never bytes', () => {
    const result = build().runs[0]!.results.find((r) => r.properties.verdict === 'VULNERABLE')!;
    expect(result.properties.evidenceRefs).toEqual([
      { ref: 'sha256:aaa', kind: 'payload' },
      { ref: 'sha256:bbb', kind: 'response' },
    ]);
    expect(result.relatedLocations.map((l) => l.physicalLocation!.artifactLocation.uri)).toEqual([
      'rtap-artifact:sha256:aaa',
      'rtap-artifact:sha256:bbb',
    ]);
  });

  it('gives every (target, probe) a stable, verdict-independent fingerprint', () => {
    const results = build().runs[0]!.results;
    for (const r of results) {
      expect(r.partialFingerprints['rtapTargetProbe/v1']).toMatch(/^[0-9a-f]{64}$/);
    }
    // Distinct (target, probe) pairs must not collide.
    const prints = new Set(results.map((r) => r.partialFingerprints['rtapTargetProbe/v1']));
    expect(prints.size).toBe(results.length);
  });

  it('reports an incomplete run as an unsuccessful execution', () => {
    const complete = build({ scheduled: 2, unresolved: [] });
    expect(complete.runs[0]!.invocations[0]!.executionSuccessful).toBe(true);
    const partial = build({ scheduled: 5, unresolved: ['t1::p9'] });
    expect(partial.runs[0]!.invocations[0]!.executionSuccessful).toBe(false);
    expect(partial.runs[0]!.invocations[0]!.properties.coverageStatus).toBe('INCOMPLETE');
    // No coverage supplied at all is UNKNOWN, not silently successful.
    expect(build().runs[0]!.invocations[0]!.executionSuccessful).toBe(false);
    expect(build().runs[0]!.properties.coverage.status).toBe('UNKNOWN');
  });

  it('stamps optional tool version and information URI, and omits them otherwise', () => {
    const driver = buildSarifReport(
      { assessmentRunId: 'run-1', generatedAt: '2026-09-04T00:00:00.000Z', observations, findings },
      { toolVersion: '1.2.3', informationUri: 'https://example.test/rtap' },
    ).runs[0]!.tool.driver;
    expect(driver.version).toBe('1.2.3');
    expect(driver.informationUri).toBe('https://example.test/rtap');
    const bare = build().runs[0]!.tool.driver;
    expect('version' in bare).toBe(false);
    expect('informationUri' in bare).toBe(false);
  });

  it('marks a suppressed finding with a SARIF suppression', () => {
    const suppressed = correlateFindings([observations[0]!]).map((f) => ({ ...f, suppressed: true }));
    const result = buildSarifReport({
      assessmentRunId: 'run-1',
      generatedAt: '2026-09-04T00:00:00.000Z',
      observations,
      findings: suppressed,
    }).runs[0]!.results[0]!;
    expect(result.suppressions).toEqual([{ kind: 'external' }]);
  });

  it('never inlines a raw payload that lives only in the artifact store', () => {
    const secret = 'SECRET-PAYLOAD-ignore-previous-instructions-4f2a9c';
    // The payload bytes live behind the ref, never in the report input.
    const withEvidence: ObservationLike[] = [
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE', evidenceRefs: [{ ref: 'sha256:deadbeef', kind: 'payload' }] },
    ];
    const serialized = JSON.stringify(
      buildSarifReport({ assessmentRunId: 'run-1', generatedAt: '2026-09-04T00:00:00.000Z', observations: withEvidence, findings: correlateFindings(withEvidence) }),
    );
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('rtap-artifact:sha256:deadbeef');
  });

  // --- result.kind: only VULNERABLE is a vulnerability alert -----------------
  it('sets result.kind so RESISTANT/UNVERIFIED/ERROR are NOT vulnerability alerts', () => {
    const obs: ObservationLike[] = [
      { id: 'o1', targetId: 't1', probeId: 'p1', verdict: 'VULNERABLE' },
      { id: 'o2', targetId: 't1', probeId: 'p2', verdict: 'RESISTANT' },
      { id: 'o3', targetId: 't1', probeId: 'p3', verdict: 'UNVERIFIED' },
      { id: 'o4', targetId: 't1', probeId: 'p4', verdict: 'ERROR' },
    ];
    const byProbe = new Map(
      buildSarifReport({ assessmentRunId: 'run-1', generatedAt: '2026-09-04T00:00:00.000Z', observations: obs, findings: correlateFindings(obs) }).runs[0]!.results.map(
        (r) => [r.properties.verdict, r] as const,
      ),
    );
    expect(byProbe.get('VULNERABLE')!.kind).toBe('fail');
    expect(byProbe.get('VULNERABLE')!.level).toBe('error');
    expect(byProbe.get('RESISTANT')!.kind).toBe('pass');
    expect(byProbe.get('RESISTANT')!.level).toBe('none');
    expect(byProbe.get('UNVERIFIED')!.kind).toBe('review');
    expect(byProbe.get('UNVERIFIED')!.level).toBe('none'); // SARIF: non-fail => level none
    expect(byProbe.get('ERROR')!.kind).toBe('notApplicable');
    expect(byProbe.get('ERROR')!.level).toBe('none');
    // The only vulnerability alert (kind:fail) is the VULNERABLE one.
    const fails = [...byProbe.values()].filter((r) => r.kind === 'fail');
    expect(fails).toHaveLength(1);
  });

  // --- Real SARIF 2.1.0 JSON Schema validation (vendored OASIS schema) -------
  describe('validates against the full SARIF 2.1.0 JSON Schema', () => {
    it('a mixed-result report is schema-valid', () => {
      const res = validateSarifAgainstSchema(build({ scheduled: 3, unresolved: [] }));
      expect(res.valid, res.errors.join('; ')).toBe(true);
    });

    it('a zero-vulnerability (all RESISTANT) report is schema-valid', () => {
      const resistantOnly: ObservationLike[] = [
        { id: 'r1', targetId: 't1', probeId: 'p1', verdict: 'RESISTANT' },
        { id: 'r2', targetId: 't1', probeId: 'p2', verdict: 'RESISTANT' },
      ];
      const log = buildSarifReport({
        assessmentRunId: 'run-1',
        generatedAt: '2026-09-04T00:00:00.000Z',
        observations: resistantOnly,
        findings: correlateFindings(resistantOnly),
        coverage: { scheduled: 2, unresolved: [] },
      });
      expect(log.runs[0]!.results.every((r) => r.kind === 'pass')).toBe(true);
      const res = validateSarifAgainstSchema(log);
      expect(res.valid, res.errors.join('; ')).toBe(true);
    });

    it('an empty (no findings) report is schema-valid', () => {
      const log = buildSarifReport({ assessmentRunId: 'run-1', generatedAt: '2026-09-04T00:00:00.000Z', observations: [], findings: [], coverage: { scheduled: 0, unresolved: [] } });
      const res = validateSarifAgainstSchema(log);
      expect(res.valid, res.errors.join('; ')).toBe(true);
    });
  });
});
