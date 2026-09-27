import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemArtifactStore } from '../src/artifacts/filesystem-store.js';
import type { EvidenceKind } from '../src/artifacts/store.js';
import { parseDuoLlmTestResult, type ParseContext } from '../src/adapters/duo-llm/parse.js';
import { materializeDuoLlmEvidence } from '../src/adapters/duo-llm/evidence.js';
import type { DuoLlmRedteamReport } from '../src/adapters/duo-llm/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures/duo-llm-redteam-report.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as DuoLlmRedteamReport;

const ctx: ParseContext = {
  assessmentRunId: 'run-1',
  targetId: 'target-chatbot',
  engineVersion: '0.1.0',
  adapterVersion: '0.1.0',
};

describe('materializeDuoLlmEvidence', () => {
  let root: string;
  let store: FilesystemArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rtap-duo-llm-evidence-test-'));
    store = new FilesystemArtifactStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('payload/response refs resolve to the exact real prompt/response text', async () => {
    const result = fixture.results.find((r) => r.attack.prompt.length > 20)!;
    const parsed = parseDuoLlmTestResult(result, 0, fixture, ctx);
    const materialized = await materializeDuoLlmEvidence(store, parsed, result, fixture);

    expect(materialized.evidenceRefs.map((e) => e.kind).sort()).toEqual(['native-report', 'payload', 'response']);

    const payloadRef = materialized.evidenceRefs.find((e) => e.kind === 'payload')!;
    const responseRef = materialized.evidenceRefs.find((e) => e.kind === 'response')!;
    expect((await store.get({ ref: payloadRef.ref, kind: 'payload' })).toString('utf-8')).toBe(result.attack.prompt);
    expect((await store.get({ ref: responseRef.ref, kind: 'response' })).toString('utf-8')).toBe(result.response);
  });

  it('never leaves the synthetic unbacked ref behind — every returned ref is a real, fetchable local:sha256 ref', async () => {
    const result = fixture.results[0]!;
    const parsed = parseDuoLlmTestResult(result, 0, fixture, ctx);
    expect(parsed.evidenceRefs.some((e) => e.ref.startsWith('duo-llm:'))).toBe(true); // the synthetic form this replaces

    const materialized = await materializeDuoLlmEvidence(store, parsed, result, fixture);
    for (const ref of materialized.evidenceRefs) {
      expect(ref.ref).toMatch(/^local:sha256:[0-9a-f]{64}$/);
      await expect(store.exists({ ref: ref.ref, kind: ref.kind as EvidenceKind })).resolves.toBe(true);
    }
  });

  it('the native-report ref is shared across every result in the same report', async () => {
    const [a, b] = fixture.results;
    expect(b).toBeDefined();
    const materializedA = await materializeDuoLlmEvidence(store, parseDuoLlmTestResult(a!, 0, fixture, ctx), a!, fixture);
    const materializedB = await materializeDuoLlmEvidence(store, parseDuoLlmTestResult(b!, 1, fixture, ctx), b!, fixture);

    const reportRefA = materializedA.evidenceRefs.find((e) => e.kind === 'native-report')!.ref;
    const reportRefB = materializedB.evidenceRefs.find((e) => e.kind === 'native-report')!.ref;
    expect(reportRefA).toBe(reportRefB);
  });
});
