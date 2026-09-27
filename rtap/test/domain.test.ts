import { describe, expect, it } from 'vitest';
import { deriveVerdict } from '../src/domain/verdict.js';
import { decideExecution } from '../src/domain/recommendation-binding.js';
import { buildRecommendationProvenance, isProvenanceFresh } from '../src/domain/recommendation-provenance.js';
import { groupNativeMetricsByNamespace } from '../src/domain/native-metrics.js';
import { emptyWorld } from '../src/world/state.js';
import { fingerprint } from '../src/world/fingerprint.js';

describe('deriveVerdict', () => {
  it('maps a real successful attack to VULNERABLE', () => {
    expect(
      deriveVerdict({
        graderKind: 'llm-judge',
        graderRan: true,
        attackSucceeded: true,
        configIgnored: false,
        transportFailure: false,
      }),
    ).toBe('VULNERABLE');
  });

  it('maps a defaulted-pass grader to UNVERIFIED, never RESISTANT', () => {
    expect(
      deriveVerdict({
        graderKind: 'defaulted-pass',
        graderRan: true,
        attackSucceeded: true,
        configIgnored: false,
        transportFailure: false,
      }),
    ).toBe('UNVERIFIED');
  });

  it('maps a transport failure to ERROR regardless of everything else', () => {
    expect(
      deriveVerdict({
        graderKind: 'llm-judge',
        graderRan: true,
        attackSucceeded: true,
        configIgnored: false,
        transportFailure: true,
      }),
    ).toBe('ERROR');
  });
});

describe('decideExecution', () => {
  const base = {
    campaignId: 'c1',
    worldGeneration: 1,
    worldEpoch: 10,
    featureSchemaVersion: '1.0.0',
    modelDigest: 'd1',
    policyVersion: 'p1',
  };

  it('allows execution when bindings are identical', () => {
    expect(decideExecution(base, base).executable).toBe(true);
  });

  it('rejects a different campaign outright', () => {
    const decision = decideExecution(base, { ...base, campaignId: 'c2' });
    expect(decision).toEqual({ executable: false, reason: 'campaign-mismatch' });
  });

  it('rejects a generation mismatch even if epoch matches', () => {
    const decision = decideExecution(base, { ...base, worldGeneration: 2 });
    expect(decision.reason).toBe('generation-mismatch');
  });

  it('allows a small epoch drift within tolerance', () => {
    const decision = decideExecution(base, { ...base, worldEpoch: 11 }, { epochTolerance: 1 });
    expect(decision.executable).toBe(true);
  });

  it('rejects epoch drift beyond tolerance', () => {
    const decision = decideExecution(base, { ...base, worldEpoch: 12 }, { epochTolerance: 1 });
    expect(decision).toEqual({ executable: false, reason: 'epoch-stale' });
  });

  it('rejects a recommendation from the future outright, ignoring tolerance', () => {
    const decision = decideExecution({ ...base, worldEpoch: 20 }, base, { epochTolerance: 100 });
    expect(decision).toEqual({ executable: false, reason: 'epoch-from-the-future' });
  });
});

describe('buildRecommendationProvenance / isProvenanceFresh', () => {
  it('worldFingerprint always equals fingerprint(world) for the exact world given', () => {
    const world = emptyWorld('campaign-1', 3);
    const provenance = buildRecommendationProvenance(world, 'feature-snapshot-ref-1', 'candidate-fc-v1');
    expect(provenance.worldFingerprint).toBe(fingerprint(world));
  });

  it('re-surfaces the exact featureSnapshotRef and compilerDigest it was given, unmodified', () => {
    const world = emptyWorld('campaign-1');
    const provenance = buildRecommendationProvenance(world, 'fs-ref-xyz', 'compiler-build-42');
    expect(provenance.featureDigest).toBe('fs-ref-xyz');
    expect(provenance.compilerDigest).toBe('compiler-build-42');
  });

  it('expiresAt is exactly createdAt + ttlMs', () => {
    const world = emptyWorld('campaign-1');
    const now = new Date('2026-08-30T00:00:00.000Z');
    const provenance = buildRecommendationProvenance(world, 'fs-1', 'compiler-1', now, 60_000);
    expect(provenance.createdAt).toBe(now.toISOString());
    expect(provenance.expiresAt).toBe(new Date(now.getTime() + 60_000).toISOString());
  });

  it('is fresh strictly before expiresAt and not fresh at or after it', () => {
    const world = emptyWorld('campaign-1');
    const now = new Date('2026-08-30T00:00:00.000Z');
    const provenance = buildRecommendationProvenance(world, 'fs-1', 'compiler-1', now, 1000);

    expect(isProvenanceFresh(provenance, now)).toBe(true);
    expect(isProvenanceFresh(provenance, new Date(now.getTime() + 999))).toBe(true);
    expect(isProvenanceFresh(provenance, new Date(now.getTime() + 1000))).toBe(false); // exactly at expiresAt — not fresh
    expect(isProvenanceFresh(provenance, new Date(now.getTime() + 1001))).toBe(false);
  });

  it('two different worlds produce two different fingerprints, and therefore two different provenance records', () => {
    const worldA = emptyWorld('campaign-1');
    const worldB = { ...emptyWorld('campaign-1'), epoch: 5, lastSequence: 5 };
    const provenanceA = buildRecommendationProvenance(worldA, 'fs-1', 'compiler-1');
    const provenanceB = buildRecommendationProvenance(worldB, 'fs-1', 'compiler-1');
    expect(provenanceA.worldFingerprint).not.toBe(provenanceB.worldFingerprint);
  });
});

describe('groupNativeMetricsByNamespace', () => {
  it('never merges values across namespaces', () => {
    const groups = groupNativeMetricsByNamespace([
      { namespace: 'promptfoo', name: 'risk', value: 5.84 },
      { namespace: 'duo', name: 'risk', value: 7.2 },
      { namespace: 'promptfoo', name: 'asr', value: 0.3 },
    ]);
    expect(groups.get('promptfoo')).toEqual([5.84, 0.3]);
    expect(groups.get('duo')).toEqual([7.2]);
    expect(groups.has('frozen')).toBe(false);
  });
});
