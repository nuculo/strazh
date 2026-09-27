import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ModelPromotionRegistry } from '../../src/promotion/registry.js';
import { packageLinearModelArtifact } from '../../src/training/model-artifact.js';
import { makeLinearRegressionBaseline } from '../../src/training/baselines/linear-regression-baseline.js';
import { signAndGate } from './signing-fixture.js';

function artifact(modelRef = 'model-1') {
  const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
  return packageLinearModelArtifact(model, {
    modelRef,
    featureSchemaVersion: '1.0.0',
    taxonomyVersion: 'taxonomy-v1',
    trainingDatasetRef: 'ds-1',
    benchmarkRef: 'bench-1',
    issuer: 'test',
  });
}

describe('ModelPromotionRegistry', () => {
  it('admits a new model at OFF', () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const record = registry.admit(artifact());
    expect(record.state).toBe('OFF');
  });

  it('admit() is idempotent — admitting the same modelRef twice does not reset its state', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const { signed, gate } = await signAndGate(artifact('m1'));
    registry.admit(signed);
    registry.applyEvent('m1', 'MODEL_ADMITTED', gate);
    registry.admit(artifact('m1')); // re-admit
    expect(registry.get('m1')?.state).toBe('SHADOW');
  });

  it('applyEvent moves state forward on a legal transition and logs it as allowed', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const { signed, gate } = await signAndGate(artifact('m1'));
    registry.admit(signed);
    const entry = registry.applyEvent('m1', 'MODEL_ADMITTED', gate);
    expect(entry.allowed).toBe(true);
    expect(registry.get('m1')?.state).toBe('SHADOW');
  });

  it('applyEvent refuses MODEL_ADMITTED without a verified SignatureGate, state stays OFF', () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    registry.admit(artifact('m1'));
    const entry = registry.applyEvent('m1', 'MODEL_ADMITTED');
    expect(entry.allowed).toBe(false);
    expect(entry.reason).toContain('SignatureGate');
    expect(registry.get('m1')?.state).toBe('OFF');
  });

  it('applyEvent refuses MODEL_ADMITTED given an explicitly unverified SignatureGate, state stays OFF', () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    registry.admit(artifact('m1'));
    const entry = registry.applyEvent('m1', 'MODEL_ADMITTED', { verified: false, reason: 'signature does not verify against the configured public key' });
    expect(entry.allowed).toBe(false);
    expect(entry.reason).toBe('signature does not verify against the configured public key');
    expect(registry.get('m1')?.state).toBe('OFF');
  });

  it('applyEvent refuses an illegal transition and logs it as disallowed, state unchanged', () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    registry.admit(artifact('m1'));
    const entry = registry.applyEvent('m1', 'AB_GATES_PASSED');
    expect(entry.allowed).toBe(false);
    expect(registry.get('m1')?.state).toBe('OFF');
  });

  it('throws applying an event to an unadmitted modelRef', () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    expect(() => registry.applyEvent('never-admitted', 'MODEL_ADMITTED')).toThrow();
  });

  it('history() records every attempted transition, allowed or not, in order', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const { signed, gate } = await signAndGate(artifact('m1'));
    registry.admit(signed);
    registry.applyEvent('m1', 'MODEL_ADMITTED', gate);
    registry.applyEvent('m1', 'INTEGRITY_OR_POLICY_FAILURE'); // illegal from SHADOW
    registry.applyEvent('m1', 'OFFLINE_AND_SHADOW_GATES_PASSED');

    const history = registry.history('m1');
    expect(history.map((h) => h.event)).toEqual(['MODEL_ADMITTED', 'INTEGRITY_OR_POLICY_FAILURE', 'OFFLINE_AND_SHADOW_GATES_PASSED']);
    expect(history.map((h) => h.allowed)).toEqual([true, false, true]);
    expect(registry.get('m1')?.state).toBe('EXPERIMENTAL');
  });

  it('walks the full documented lifecycle: OFF -> SHADOW -> EXPERIMENTAL -> CALIBRATED -> SHADOW (drift)', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const { signed, gate } = await signAndGate(artifact('m1'));
    registry.admit(signed);
    registry.applyEvent('m1', 'MODEL_ADMITTED', gate);
    registry.applyEvent('m1', 'OFFLINE_AND_SHADOW_GATES_PASSED');
    // грань №18: AB_GATES_PASSED is now signature-gated too — the artifact's
    // bytes never changed, so the same gate from admission is still valid.
    registry.applyEvent('m1', 'AB_GATES_PASSED', gate);
    expect(registry.get('m1')?.state).toBe('CALIBRATED');
    registry.applyEvent('m1', 'DRIFT_OR_QUALITY_REGRESSION');
    expect(registry.get('m1')?.state).toBe('SHADOW');
  });

  it('listAll() returns an empty array when nothing has been admitted', () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    expect(registry.listAll()).toEqual([]);
  });

  it('listAll() returns every admitted model, ordered by modelRef, reflecting current state', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    registry.admit(artifact('m2'));
    const { signed, gate } = await signAndGate(artifact('m1'));
    registry.admit(signed);
    registry.applyEvent('m1', 'MODEL_ADMITTED', gate); // m1 -> SHADOW, m2 stays OFF

    const all = registry.listAll();
    expect(all.map((r) => r.modelRef)).toEqual(['m1', 'm2']); // alphabetical, not insertion order
    expect(all.find((r) => r.modelRef === 'm1')?.state).toBe('SHADOW');
    expect(all.find((r) => r.modelRef === 'm2')?.state).toBe('OFF');
  });
});
