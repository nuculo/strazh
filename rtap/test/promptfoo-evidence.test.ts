import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemArtifactStore } from '../src/artifacts/filesystem-store.js';
import { parsePromptfooResult, type ParseContext } from '../src/adapters/promptfoo/parse.js';
import { materializePromptfooEvidence } from '../src/adapters/promptfoo/evidence.js';
import type { PromptfooOutputFile } from '../src/adapters/promptfoo/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures/promptfoo-eval-result.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as PromptfooOutputFile;

const ctx: ParseContext = {
  assessmentRunId: 'run-1',
  targetId: 'target-1',
  nativeRunId: fixture.evalId ?? 'unknown',
  engineVersion: '0.122.0',
  adapterVersion: '0.1.0',
};

describe('materializePromptfooEvidence', () => {
  let root: string;
  let store: FilesystemArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rtap-promptfoo-evidence-test-'));
    store = new FilesystemArtifactStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('replaces the synthetic evidenceRef with a real one that resolves to the native result', async () => {
    const [result] = fixture.results;
    const parsed = parsePromptfooResult(result!, 0, ctx);
    expect(parsed.evidenceRefs[0]!.ref).toMatch(/^promptfoo:/); // the synthetic ref this replaces

    const materialized = await materializePromptfooEvidence(store, parsed, result!);
    expect(materialized.evidenceRefs).toHaveLength(1);
    expect(materialized.evidenceRefs[0]!.kind).toBe('native-report');
    expect(materialized.evidenceRefs[0]!.ref).toMatch(/^local:sha256:[0-9a-f]{64}$/);

    const stored = await store.get({ ref: materialized.evidenceRefs[0]!.ref, kind: 'native-report' });
    expect(JSON.parse(stored.toString('utf-8'))).toEqual(result);
  });

  it('every field but evidenceRefs is unchanged from the pure parse', async () => {
    const [result] = fixture.results;
    const parsed = parsePromptfooResult(result!, 0, ctx);
    const materialized = await materializePromptfooEvidence(store, parsed, result!);
    const { evidenceRefs: _parsedRefs, ...parsedRest } = parsed;
    const { evidenceRefs: _materializedRefs, ...materializedRest } = materialized;
    expect(materializedRest).toEqual(parsedRest);
  });

  it('two different results produce two different, independently fetchable refs', async () => {
    const [r1, r2] = fixture.results;
    expect(r2).toBeDefined();
    const m1 = await materializePromptfooEvidence(store, parsePromptfooResult(r1!, 0, ctx), r1!);
    const m2 = await materializePromptfooEvidence(store, parsePromptfooResult(r2!, 1, ctx), r2!);
    expect(m1.evidenceRefs[0]!.ref).not.toBe(m2.evidenceRefs[0]!.ref);
  });
});
