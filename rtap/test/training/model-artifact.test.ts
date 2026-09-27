import { describe, expect, it } from 'vitest';
import { packageLinearModelArtifact } from '../../src/training/model-artifact.js';
import { makeLinearRegressionBaseline } from '../../src/training/baselines/linear-regression-baseline.js';
import { validate } from '../../src/schemas/index.js';

const ctx = {
  modelRef: 'linear-v1',
  featureSchemaVersion: '1.0.0',
  taxonomyVersion: 'taxonomy-v1',
  trainingDatasetRef: 'dataset-2026-08-30',
  benchmarkRef: 'bench-2026-08-30',
  issuer: 'rtap-phase2-offline-training',
};

describe('packageLinearModelArtifact', () => {
  it('produces an artifact that validates against rtap:model-snapshot', () => {
    const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
    const artifact = packageLinearModelArtifact(model, ctx);
    const check = validate('rtap:model-snapshot', artifact);
    expect(check.valid, check.errors.join('; ')).toBe(true);
  });

  it('computes a real sha256 (deterministic for identical weights)', () => {
    const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
    const a = packageLinearModelArtifact(model, ctx);
    const b = packageLinearModelArtifact(model, ctx);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.sha256).toBe(b.sha256);
  });

  it('is honestly unsigned — signature is a visible sentinel, not fabricated', () => {
    const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
    const artifact = packageLinearModelArtifact(model, ctx);
    expect(artifact.signature).toBe('UNSIGNED');
  });

  it('different weights produce different digests', () => {
    const modelA = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
    const modelB = { ...modelA, weights: [...modelA.weights], bias: modelA.bias + 1 };
    const a = packageLinearModelArtifact(modelA, ctx);
    const b = packageLinearModelArtifact(modelB, ctx);
    expect(a.sha256).not.toBe(b.sha256);
  });
});
