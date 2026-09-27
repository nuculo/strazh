import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ModelPromotionRegistry } from '../../src/promotion/registry.js';
import { admitModel, type AdmitModelConfig } from '../../src/promotion/admit-model.js';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { testSigningAuthority } from './signing-fixture.js';

function config(overrides: Partial<AdmitModelConfig> = {}): AdmitModelConfig {
  return {
    featureSchemaVersion: '1.0.0',
    taxonomyVersion: 'taxonomy-v1',
    trainingDatasetRef: 'ds-1',
    benchmarkRef: 'bench-1',
    issuer: 'test',
    weights: { weights: [0.1, 0.2, 0.3], bias: 0.05 },
    ...overrides,
  };
}

describe('admitModel', () => {
  let artifactsDir: string;
  let artifactStore: FilesystemArtifactStore;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'rtap-admit-model-test-'));
    artifactStore = new FilesystemArtifactStore(artifactsDir);
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reconstructs a model from serialized weights, signs it, persists weights durably, and admits it at OFF', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const result = await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', config());

    expect(result.record.state).toBe('OFF');
    expect(result.record.artifact.featureSchemaVersion).toBe('1.0.0');
    expect(result.record.artifact.signature).not.toBe('UNSIGNED');
    expect(result.record.artifact.weightsRef).not.toBeNull();
    expect(result.record.artifact.weightsRef?.ref).toBe(`local:sha256:${result.record.artifact.sha256}`);
    expect(result.alreadyAdmitted).toBe(false);
    expect(result.artifactMismatch).toBe(false);
  });

  it('re-admitting the identical config is a reported no-op, not a silent re-write', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const authority = testSigningAuthority();
    const first = await admitModel(registry, artifactStore, authority, 'm1', config());
    const second = await admitModel(registry, artifactStore, authority, 'm1', config());

    expect(second.alreadyAdmitted).toBe(true);
    expect(second.artifactMismatch).toBe(false); // same weights -> same sha256
    expect(second.record.artifact.sha256).toBe(first.record.artifact.sha256);
  });

  it('re-admitting a genuinely different model under the same modelRef reports the mismatch — the registry keeps the first artifact, not the new one', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const authority = testSigningAuthority();
    const first = await admitModel(registry, artifactStore, authority, 'm1', config());
    const second = await admitModel(registry, artifactStore, authority, 'm1', config({ weights: { weights: [9, 9, 9], bias: 9 } }));

    expect(second.alreadyAdmitted).toBe(true);
    expect(second.artifactMismatch).toBe(true);
    // The registry's own admit() semantics: whichever artifact landed first wins.
    expect(second.record.artifact.sha256).toBe(first.record.artifact.sha256);
  });

  it('promoting after admit moves state — a verified SignatureGate is required for MODEL_ADMITTED', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const authority = testSigningAuthority();
    await admitModel(registry, artifactStore, authority, 'm1', config());

    const record = registry.get('m1')!;
    const { signature, ...withoutSignature } = record.artifact;
    const verifyResult = await authority.verify({ artifact: withoutSignature, signature });
    expect(verifyResult.valid).toBe(true);

    const transition = registry.applyEvent('m1', 'MODEL_ADMITTED', { verified: verifyResult.valid });
    expect(transition.to).toBe('SHADOW');
    expect(registry.get('m1')?.state).toBe('SHADOW');
  });

  it('MODEL_ADMITTED is refused, state stays OFF, when no SignatureGate is provided at all', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', config());

    const transition = registry.applyEvent('m1', 'MODEL_ADMITTED');
    expect(transition.allowed).toBe(false);
    expect(registry.get('m1')?.state).toBe('OFF');
  });
});
