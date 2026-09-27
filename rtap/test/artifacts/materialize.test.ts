import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { materializeEvidence } from '../../src/artifacts/materialize.js';

describe('materializeEvidence', () => {
  let root: string;
  let store: FilesystemArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rtap-materialize-test-'));
    store = new FilesystemArtifactStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes each body and returns real refs, in the same order', async () => {
    const refs = await materializeEvidence(store, 'run-1', [
      { kind: 'payload', body: 'attack text' },
      { kind: 'response', body: 'model output' },
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.kind).toBe('payload');
    expect(refs[1]!.kind).toBe('response');
    expect(refs[0]!.ref).toMatch(/^local:sha256:[0-9a-f]{64}$/);

    expect((await store.get(refs[0]!)).toString('utf-8')).toBe('attack text');
    expect((await store.get(refs[1]!)).toString('utf-8')).toBe('model output');
  });

  it('an empty body list produces an empty ref list', async () => {
    const refs = await materializeEvidence(store, 'run-1', []);
    expect(refs).toEqual([]);
  });

  it('identical bodies across separate calls converge to the same ref — no duplicate storage cost', async () => {
    const shared = JSON.stringify({ scanId: 'scan-1', findings: [1, 2, 3] });
    const first = await materializeEvidence(store, 'run-1', [{ kind: 'native-report', body: shared }]);
    const second = await materializeEvidence(store, 'run-1', [{ kind: 'native-report', body: shared }]);
    expect(first[0]!.ref).toBe(second[0]!.ref);
  });
});
