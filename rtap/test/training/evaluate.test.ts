import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/training/evaluate.js';
import type { TrainingExample } from '../../src/training/dataset-exporter.js';
import type { CandidateFeatureSnapshot } from '../../src/features/candidate-compiler.js';

function example(label: number, probeId = 'p1:s1'): TrainingExample {
  const features: CandidateFeatureSnapshot = {
    featureSchemaVersion: '1.0.0',
    normalizationVersion: 'n1',
    taxonomyVersion: 't1',
    compilerBuild: 'b1',
    featureView: 'CANDIDATE',
    sourceObservationId: null,
    candidateProbeId: probeId,
    vector: Array.from({ length: 60 }, () => 0),
  };
  return { campaignId: 'c1', targetId: 't1', probeId, occurredAt: '2026-08-30T00:00:00.000Z', features, label };
}

describe('evaluate', () => {
  it('a perfect predictor scores mse=0, mae=0, rankCorrelation=1', () => {
    const holdout = [example(1), example(2), example(3)];
    const result = evaluate({ name: 'perfect', predict: (f) => holdout.find((e) => e.features === f)!.label }, holdout);
    expect(result.mse).toBe(0);
    expect(result.mae).toBe(0);
    expect(result.rankCorrelation).toBeCloseTo(1, 10);
  });

  it('an inversely-ordered predictor scores rankCorrelation close to -1', () => {
    const holdout = [example(1), example(2), example(3)];
    const result = evaluate({ name: 'inverse', predict: (f) => -holdout.find((e) => e.features === f)!.label }, holdout);
    expect(result.rankCorrelation).toBeCloseTo(-1, 10);
  });

  it('handles an empty holdout without throwing', () => {
    const result = evaluate({ name: 'x', predict: () => 0 }, []);
    expect(result.n).toBe(0);
    expect(Number.isNaN(result.mse)).toBe(true);
  });

  it('handles ties in predictions', () => {
    const holdout = [example(1), example(1), example(2)];
    const result = evaluate({ name: 'const', predict: () => 5 }, holdout);
    expect(Number.isNaN(result.rankCorrelation)).toBe(true); // zero variance in predictions
  });
});
