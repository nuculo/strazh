import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { ArtifactNotFoundError, MalformedArtifactRefError } from '../../src/artifacts/store.js';

describe('FilesystemArtifactStore', () => {
  let root: string;
  let store: FilesystemArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rtap-artifact-test-'));
    store = new FilesystemArtifactStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a string body', async () => {
    const ref = await store.put({ assessmentRunId: 'run-1', kind: 'payload', body: 'attack payload text' });
    expect(ref.kind).toBe('payload');
    expect(ref.ref).toMatch(/^local:sha256:[0-9a-f]{64}$/);
    const body = await store.get(ref);
    expect(body.toString('utf-8')).toBe('attack payload text');
  });

  it('round-trips a binary body', async () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const ref = await store.put({ assessmentRunId: 'run-1', kind: 'trace', body: bytes });
    const body = await store.get(ref);
    expect([...body]).toEqual([...bytes]);
  });

  it('is content-addressed: identical bytes produce the identical ref', async () => {
    const a = await store.put({ assessmentRunId: 'run-1', kind: 'response', body: 'same content' });
    const b = await store.put({ assessmentRunId: 'run-2', kind: 'response', body: 'same content' });
    expect(a.ref).toBe(b.ref);
  });

  it('exists() is true after put and false for an unwritten ref', async () => {
    const ref = await store.put({ assessmentRunId: 'run-1', kind: 'snippet', body: 'x' });
    expect(await store.exists(ref)).toBe(true);
    expect(await store.exists({ ref: `local:sha256:${'0'.repeat(64)}`, kind: 'snippet' })).toBe(false);
  });

  it('get() throws ArtifactNotFoundError for a well-formed but unwritten ref', async () => {
    await expect(store.get({ ref: `local:sha256:${'a'.repeat(64)}`, kind: 'payload' })).rejects.toThrow(ArtifactNotFoundError);
  });

  it('get() rejects a malformed ref rather than trusting it as a path', async () => {
    await expect(store.get({ ref: 'local:sha256:../../etc/passwd', kind: 'payload' })).rejects.toThrow(MalformedArtifactRefError);
    await expect(store.get({ ref: '../../etc/passwd', kind: 'payload' })).rejects.toThrow(MalformedArtifactRefError);
  });
});
