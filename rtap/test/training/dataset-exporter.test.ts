import { describe, expect, it } from 'vitest';
import { exportDataset } from '../../src/training/dataset-exporter.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from './fixtures.js';

describe('exportDataset', () => {
  it('produces one example per non-excluded record, each with a schema-valid CANDIDATE snapshot', () => {
    const { records, eventStore } = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 5 });
    const allEvents = allEventsAcrossCampaigns(eventStore, ['campaign-0']);
    const result = exportDataset(records, allEvents);

    expect(result.examples).toHaveLength(5);
    for (const example of result.examples) {
      expect(example.features.featureView).toBe('CANDIDATE');
      expect(example.features.vector).toHaveLength(60);
      expect(Number.isFinite(example.label)).toBe(true);
    }
  });

  it('excludes duo defaulted-pass observations', () => {
    const { records, eventStore } = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 3 });
    const tampered = records.map((r, i) => (i === 0 ? { ...r, observation: { ...r.observation, provenance: { ...r.observation.provenance, graderKind: 'defaulted-pass' } } } : r));
    const allEvents = allEventsAcrossCampaigns(eventStore, ['campaign-0']);
    const result = exportDataset(tampered, allEvents);

    expect(result.excludedCount).toBe(1);
    expect(result.excludedReasons['duo-defaulted-pass']).toBe(1);
    expect(result.examples).toHaveLength(2);
  });

  it('excludes config-ignored observations', () => {
    const { records, eventStore } = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 3 });
    const tampered = records.map((r, i) => (i === 0 ? { ...r, observation: { ...r.observation, provenance: { ...r.observation.provenance, configIgnored: true } } } : r));
    const allEvents = allEventsAcrossCampaigns(eventStore, ['campaign-0']);
    const result = exportDataset(tampered, allEvents);

    expect(result.excludedReasons['config-ignored']).toBe(1);
  });

  it('reconstructs history strictly before each record — target attempts-so-far is non-decreasing in commit order', () => {
    const { records, eventStore } = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 6 });
    const allEvents = allEventsAcrossCampaigns(eventStore, ['campaign-0']);
    const result = exportDataset(records, allEvents);

    // All 6 probes share one target, so the target-attempts-so-far coordinate
    // (campaign history group, offset 3) accumulates monotonically across the
    // chronologically-ordered examples — each later example's "before" history
    // includes one more committed attempt on that target than the last.
    const targetAttemptsCoord = 42 + 3; // COORD.CAMPAIGN_HISTORY.start + 3
    const values = result.examples.map((e) => e.features.vector[targetAttemptsCoord]!);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }
    expect(values[0]).toBe(0); // the very first probe on this target sees no prior attempts
  });
});
