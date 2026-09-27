import { describe, expect, it } from 'vitest';
import { buildCounterfactual } from '../../src/shadow/counterfactual.js';
import { buildHistoryView } from '../../src/features/history-view.js';
import { heuristicBaseline } from '../../src/training/baselines/heuristic-baseline.js';
import type { ProbeCatalogEntry } from '../../src/candidates/catalog.js';

const catalog: ProbeCatalogEntry[] = [
  { probeId: 'prompt-injection:base64', mandatory: false },
  { probeId: 'pii-leak:default', mandatory: false },
  { probeId: 'jailbreak:default', mandatory: false },
];
const emptyHistory = buildHistoryView([], 'campaign-1', 0);
const world = { worldGeneration: 0, worldEpoch: 0 };
const budget = { targetCallsUsed: 0, targetCallsBudget: 100 };

describe('buildCounterfactual', () => {
  it('includes the actually-executed probe in the candidate set even if not in catalog', () => {
    const model = heuristicBaseline.fit([]);
    const record = buildCounterfactual(model, 'heuristic', catalog, 't1', 'never-cataloged:probe', 0.5, emptyHistory, world, budget);
    expect(record.actualProbeId).toBe('never-cataloged:probe');
    expect(record.modelRank).not.toBeNull();
    expect(record.eligibleCount).toBe(catalog.length + 1);
  });

  it('reports modelWasBest=true when the model ranked the actual choice #1', () => {
    const modelThatLovesPromptInjection = {
      name: 'biased',
      predict: (f: { candidateProbeId: string }) => (f.candidateProbeId === 'prompt-injection:base64' ? 100 : 0),
    };
    const record = buildCounterfactual(modelThatLovesPromptInjection, 'biased', catalog, 't1', 'prompt-injection:base64', 1, emptyHistory, world, budget);
    expect(record.modelRank).toBe(1);
    expect(record.modelWasBest).toBe(true);
  });

  it('computes a rank for the heuristic and random baselines too, not just the primary model', () => {
    const model = heuristicBaseline.fit([]);
    const record = buildCounterfactual(model, 'heuristic', catalog, 't1', 'pii-leak:default', 0.2, emptyHistory, world, budget);
    expect(record.heuristicRank).not.toBeNull();
    expect(record.randomRank).not.toBeNull();
    expect(record.heuristicRank).toBeGreaterThanOrEqual(1);
    expect(record.heuristicRank).toBeLessThanOrEqual(record.eligibleCount);
  });

  it('carries the actual outcome label through untouched — this is what makes it a counterfactual, not just a ranking', () => {
    const model = heuristicBaseline.fit([]);
    const record = buildCounterfactual(model, 'heuristic', catalog, 't1', 'jailbreak:default', 0.77, emptyHistory, world, budget);
    expect(record.actualLabel).toBe(0.77);
  });
});
