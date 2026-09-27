import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemArtifactStore } from '../src/artifacts/filesystem-store.js';
import { parseDuoStaticFinding, type ParseContext } from '../src/adapters/duo-static/parse.js';
import { materializeDuoStaticEvidence } from '../src/adapters/duo-static/evidence.js';
import type { DuoStaticScanResult } from '../src/adapters/duo-static/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures/duo-static-scan-result.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as DuoStaticScanResult;

const ctx: ParseContext = {
  assessmentRunId: 'run-1',
  targetId: 'target-gitlabhq',
  engineVersion: '0.1.0',
  adapterVersion: '0.1.0',
};

describe('materializeDuoStaticEvidence', () => {
  let root: string;
  let store: FilesystemArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rtap-duo-static-evidence-test-'));
    store = new FilesystemArtifactStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a finding with a real code_snippet gets a real snippet ref that resolves to that exact text', async () => {
    const withSnippet = fixture.findings.find((f) => f.code_snippet !== null)!;
    expect(withSnippet).toBeDefined();
    const parsed = parseDuoStaticFinding(withSnippet, 0, fixture, ctx);

    const materialized = await materializeDuoStaticEvidence(store, parsed, withSnippet, fixture);
    expect(materialized.evidenceRefs.map((e) => e.kind).sort()).toEqual(['native-report', 'snippet']);

    const snippetRef = materialized.evidenceRefs.find((e) => e.kind === 'snippet')!;
    const stored = await store.get({ ref: snippetRef.ref, kind: 'snippet' });
    expect(stored.toString('utf-8')).toBe(withSnippet.code_snippet);
  });

  it('a finding with no code_snippet gets only a native-report ref — no fabricated snippet', async () => {
    const withoutSnippet = fixture.findings.find((f) => f.code_snippet === null);
    if (!withoutSnippet) return; // this real fixture may or may not have one; the invariant is what's checked when it does
    const parsed = parseDuoStaticFinding(withoutSnippet, 0, fixture, ctx);
    const materialized = await materializeDuoStaticEvidence(store, parsed, withoutSnippet, fixture);
    expect(materialized.evidenceRefs.map((e) => e.kind)).toEqual(['native-report']);
  });

  it('the native-report ref is shared across every finding in the same scan — one ref, not one per finding', async () => {
    const [a, b] = fixture.findings;
    expect(b).toBeDefined();
    const materializedA = await materializeDuoStaticEvidence(store, parseDuoStaticFinding(a!, 0, fixture, ctx), a!, fixture);
    const materializedB = await materializeDuoStaticEvidence(store, parseDuoStaticFinding(b!, 1, fixture, ctx), b!, fixture);

    const reportRefA = materializedA.evidenceRefs.find((e) => e.kind === 'native-report')!.ref;
    const reportRefB = materializedB.evidenceRefs.find((e) => e.kind === 'native-report')!.ref;
    expect(reportRefA).toBe(reportRefB);

    const stored = await store.get({ ref: reportRefA, kind: 'native-report' });
    expect(JSON.parse(stored.toString('utf-8'))).toEqual(fixture);
  });
});
