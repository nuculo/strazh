import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validate } from '../src/schemas/index.js';
import { parseDuoLlmTestResult, parseDuoLlmRedteamReport, type ParseContext } from '../src/adapters/duo-llm/parse.js';
import { DuoLlmCliAdapter, DECLARED_CAPABILITIES, REQUIRED_CAPABILITIES } from '../src/adapters/duo-llm/run.js';
import { checkCapabilities } from '../src/adapters/capability.js';
import { UNGRADED_SENTINEL, type DuoLlmRedteamReport } from '../src/adapters/duo-llm/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures/duo-llm-redteam-report.json');
// Real captured output of `duo-agents redteam --format json`, not hand-written —
// see types.ts's doc comment.
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as DuoLlmRedteamReport;

const ctx: ParseContext = {
  assessmentRunId: 'run-1',
  targetId: 'target-chatbot',
  engineVersion: '0.1.0',
  adapterVersion: '0.1.0',
};

describe('parseDuoLlmTestResult', () => {
  it('always maps to UNVERIFIED, including the one real captured "vulnerability"', () => {
    const dosHit = fixture.results.find((r) => r.grade.pass === false);
    expect(dosHit).toBeDefined(); // the fixture really does contain a graded failure — see reasoning-dos below
    for (const result of fixture.results) {
      const obs = parseDuoLlmTestResult(result, 0, fixture, ctx);
      expect(obs.verdict).toBe('UNVERIFIED');
    }
  });

  it('every parsed observation validates against rtap:observation', () => {
    for (const [i, result] of fixture.results.entries()) {
      const obs = parseDuoLlmTestResult(result, i, fixture, ctx);
      const check = validate('rtap:observation', obs);
      expect(check.valid, check.errors.join('; ')).toBe(true);
    }
  });

  it('sets configIgnored: true unconditionally — strategies/domains are ignored for every attack, not only some', () => {
    for (const [i, result] of fixture.results.entries()) {
      const obs = parseDuoLlmTestResult(result, i, fixture, ctx);
      expect(obs.provenance.configIgnored).toBe(true);
    }
  });

  it("marks the UNGRADED_SENTINEL default-pass results as graderKind 'defaulted-pass' with no score metric", () => {
    const index = fixture.results.findIndex((r) => r.grade.reason === UNGRADED_SENTINEL);
    expect(index).toBeGreaterThanOrEqual(0);
    const obs = parseDuoLlmTestResult(fixture.results[index]!, index, fixture, ctx);
    expect(obs.provenance.graderKind).toBe('defaulted-pass');
    expect(obs.nativeMetrics).toEqual([]);
  });

  it("marks a real-grader result as graderKind 'deterministic-verifier' and preserves its score as a duo NativeMetric", () => {
    const index = fixture.results.findIndex((r) => r.grade.reason !== UNGRADED_SENTINEL);
    expect(index).toBeGreaterThanOrEqual(0);
    const result = fixture.results[index]!;
    const obs = parseDuoLlmTestResult(result, index, fixture, ctx);
    expect(obs.provenance.graderKind).toBe('deterministic-verifier');
    expect(obs.nativeMetrics).toEqual([{ namespace: 'duo', name: 'grade-score', value: result.grade.score }]);
  });

  it('never inlines the raw prompt/response text — only evidence refs', () => {
    const withRealContent = fixture.results.find((r) => r.attack.prompt.length > 20)!;
    const obs = parseDuoLlmTestResult(withRealContent, 0, fixture, ctx);
    expect(JSON.stringify(obs)).not.toContain(withRealContent.attack.prompt);
    expect(JSON.stringify(obs)).not.toContain(withRealContent.response);
    expect(obs.evidenceRefs.map((e) => e.kind).sort()).toEqual(['native-report', 'payload', 'response']);
  });

  it('probeId combines plugin_id and strategy_id, falling back cleanly — every real capture has strategy_id: null', () => {
    expect(fixture.results.every((r) => r.attack.strategy_id === null)).toBe(true);
    const obs = parseDuoLlmTestResult(fixture.results[0]!, 0, fixture, ctx);
    expect(obs.probeId).toBe(`${fixture.results[0]!.attack.plugin_id}:none`);
  });

  it('parseDuoLlmRedteamReport produces one Observation per result', () => {
    const observations = parseDuoLlmRedteamReport(fixture, ctx);
    expect(observations).toHaveLength(fixture.results.length);
  });
});

describe('DuoLlmCliAdapter capability gate', () => {
  it("DECLARED_CAPABILITIES is missing every one of REQUIRED_CAPABILITIES today", () => {
    const check = checkCapabilities(DECLARED_CAPABILITIES, REQUIRED_CAPABILITIES);
    expect(check.permitted).toBe(false);
    expect([...check.missing].sort()).toEqual([...REQUIRED_CAPABILITIES].sort());
  });

  it('run() rejects before ever calling execFn', async () => {
    let execCalled = false;
    const adapter = new DuoLlmCliAdapter(async () => {
      execCalled = true;
      return { stdout: '', stderr: '' };
    });
    const result = await adapter.run({ outputPath: 'out.json' });
    expect(execCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejectedCapabilities).toEqual(REQUIRED_CAPABILITIES);
    }
  });

  it('reports a structured error instead of throwing when the (hypothetically enabled) process fails', async () => {
    // Exercises the real invocation path independent of the capability gate itself
    // by constructing an adapter subclass is unnecessary here — the gate always
    // rejects first today, which is exactly what's being verified above; this test
    // only confirms the gate's rejection is itself a normal return, never a throw.
    const adapter = new DuoLlmCliAdapter(async () => {
      throw new Error('duo-agents: command not found');
    });
    await expect(adapter.run({ outputPath: 'out.json' })).resolves.toMatchObject({ ok: false });
  });
});
