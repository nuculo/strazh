import { describe, expect, it } from 'vitest';
import { splitByTarget, splitByCampaign, splitByTime, splitByVulnerabilityClass, checkNoLeakage } from '../../src/training/splits.js';
import { exportDataset } from '../../src/training/dataset-exporter.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from './fixtures.js';

function corpus() {
  const built = buildSyntheticCorpus({ campaigns: 3, targetsPerCampaign: 2, probesPerTarget: 6 });
  const allEvents = allEventsAcrossCampaigns(built.eventStore, ['campaign-0', 'campaign-1', 'campaign-2']);
  return exportDataset(built.records, allEvents).examples;
}

describe('splits', () => {
  it('splitByTarget puts every example for a held-out target on the holdout side, none in train', () => {
    const examples = corpus();
    const holdoutTarget = examples[0]!.targetId;
    const { train, holdout } = splitByTarget(examples, new Set([holdoutTarget]));

    expect(holdout.every((e) => e.targetId === holdoutTarget)).toBe(true);
    expect(train.every((e) => e.targetId !== holdoutTarget)).toBe(true);
    expect(checkNoLeakage({ train, holdout }, (e) => e.targetId).clean).toBe(true);
  });

  it('splitByCampaign is clean by campaignId', () => {
    const examples = corpus();
    const { train, holdout } = splitByCampaign(examples, new Set(['campaign-0']));
    expect(checkNoLeakage({ train, holdout }, (e) => e.campaignId).clean).toBe(true);
    expect(holdout.length).toBeGreaterThan(0);
  });

  it('splitByTime holds out everything at or after the cutoff', () => {
    const examples = corpus();
    const sorted = [...examples].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const cutoff = sorted[Math.floor(sorted.length / 2)]!.occurredAt;
    const { train, holdout } = splitByTime(examples, cutoff);
    expect(train.every((e) => e.occurredAt < cutoff)).toBe(true);
    expect(holdout.every((e) => e.occurredAt >= cutoff)).toBe(true);
  });

  it('splitByVulnerabilityClass holds out whole classes, not individual probes', () => {
    const examples = corpus();
    const { train, holdout } = splitByVulnerabilityClass(examples, new Set(['prompt-injection']));
    expect(holdout.every((e) => e.probeId.startsWith('prompt-injection:'))).toBe(true);
    expect(train.every((e) => !e.probeId.startsWith('prompt-injection:'))).toBe(true);
  });

  it('checkNoLeakage reports overlap when a split is not group-clean', () => {
    const examples = corpus();
    const sameTarget = examples[0]!.targetId;
    const withSameTargetOnBothSides = examples.filter((e) => e.targetId === sameTarget);
    expect(withSameTargetOnBothSides.length).toBeGreaterThanOrEqual(2); // corpus guarantee: 6 probes/target

    const fakeSplit = { train: [withSameTargetOnBothSides[0]!], holdout: [withSameTargetOnBothSides[1]!] };
    const result = checkNoLeakage(fakeSplit, (e) => e.targetId);
    expect(result.clean).toBe(false);
    expect(result.overlapping).toEqual([sameTarget]);
  });
});
