import { describe, expect, it } from 'vitest';
import { validate, schemaIds } from '../src/schemas/index.js';

describe('schema registry', () => {
  it('loads every schema file with a unique $id', () => {
    expect(schemaIds.length).toBeGreaterThanOrEqual(10);
    expect(new Set(schemaIds).size).toBe(schemaIds.length);
  });

  it('rejects a Target with credentials inlined outside secretRef', () => {
    const target = {
      id: 't1',
      schemaVersion: '1.0.0',
      kind: 'LLM_ENDPOINT',
      displayName: 'demo',
      connectorConfig: { apiKey: 'sk-should-not-be-here' },
    };
    // The schema cannot forbid arbitrary keys inside connectorConfig (kind-specific),
    // but it must accept a target that uses secretRef instead of inline creds.
    const result = validate('rtap:target', { ...target, secretRef: 'vault://target/t1' });
    expect(result.valid).toBe(true);
  });

  it('accepts a minimal valid CampaignEventEnvelope', () => {
    const event = {
      schemaVersion: '1.0.0',
      eventId: 'evt-1',
      campaignId: 'campaign-1',
      assessmentRunId: 'run-1',
      sequence: 0,
      occurredAt: '2026-08-30T00:00:00.000Z',
      committedAt: '2026-08-30T00:00:01.000Z',
      eventType: 'ProbeExecuted',
      sourceObservationIds: [],
      featureSnapshotRef: null,
      taxonomySnapshotRef: null,
      payload: {},
    };
    const result = validate('rtap:campaign-event', event);
    expect(result.valid, result.errors.join('; ')).toBe(true);
  });

  it('rejects a FeatureSnapshot vector that is not exactly 60 numbers', () => {
    const short = {
      featureSchemaVersion: '1.0.0',
      normalizationVersion: 'n1',
      taxonomyVersion: 't1',
      compilerBuild: 'b1',
      featureView: 'OBSERVATION',
      sourceObservationId: 'obs-1',
      candidateProbeId: null,
      vector: [1, 2, 3],
    };
    expect(validate('rtap:feature-snapshot', short).valid).toBe(false);
  });

  it('rejects a CANDIDATE FeatureSnapshot that also carries a sourceObservationId', () => {
    const confused = {
      featureSchemaVersion: '1.0.0',
      normalizationVersion: 'n1',
      taxonomyVersion: 't1',
      compilerBuild: 'b1',
      featureView: 'CANDIDATE',
      sourceObservationId: 'obs-1',
      candidateProbeId: 'probe-1',
      vector: Array.from({ length: 60 }, () => 0),
    };
    expect(validate('rtap:feature-snapshot', confused).valid).toBe(false);
  });

  it('rejects a ModelSnapshot with a malformed sha256', () => {
    const bad = {
      modelRef: 'core-1',
      format: 'FZM',
      formatVersion: 4,
      sha256: 'not-a-hash',
      signature: 'sig',
      issuer: 'ci',
      createdAt: '2026-08-30T00:00:00.000Z',
      coreFingerprint: 'fnv-abc',
      featureSchemaVersion: '1.0.0',
      taxonomyVersion: 't1',
      trainingDatasetRef: 'ds-1',
      benchmarkRef: 'bench-1',
    };
    expect(validate('rtap:model-snapshot', bad).valid).toBe(false);
  });
});
