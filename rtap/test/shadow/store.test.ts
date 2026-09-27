import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ShadowRankingStore } from '../../src/shadow/store.js';
import { rankCandidates } from '../../src/shadow/rank.js';
import { compileCandidateFeatures } from '../../src/features/candidate-compiler.js';
import { buildHistoryView } from '../../src/features/history-view.js';
import { heuristicBaseline } from '../../src/training/baselines/heuristic-baseline.js';

const emptyHistory = buildHistoryView([], 'campaign-1', 0);

describe('ShadowRankingStore', () => {
  it('persists and lists a ranking in rank order', () => {
    const db = openInMemoryDatabase();
    const store = new ShadowRankingStore(db);
    const model = heuristicBaseline.fit([]);
    const features = ['p1:s1', 'p2:s1', 'p3:s1'].map((probeId) =>
      compileCandidateFeatures({ targetId: 't1', probe: { probeId }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory),
    );
    const { ranked } = rankCandidates(model, 'heuristic', features, { worldGeneration: 0, worldEpoch: 0 }, 'SHADOW');

    store.persist('campaign-1', 't1', ranked);
    const listed = store.listByTarget('campaign-1', 't1');

    expect(listed).toHaveLength(3);
    expect(listed.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('scopes listings by campaign and target', () => {
    const db = openInMemoryDatabase();
    const store = new ShadowRankingStore(db);
    const model = heuristicBaseline.fit([]);
    const f = compileCandidateFeatures({ targetId: 't1', probe: { probeId: 'p1:s1' }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, emptyHistory);
    const { ranked } = rankCandidates(model, 'heuristic', [f], { worldGeneration: 0, worldEpoch: 0 }, 'SHADOW');

    store.persist('campaign-1', 't1', ranked);
    store.persist('campaign-1', 't2', ranked);
    store.persist('campaign-2', 't1', ranked);

    expect(store.listByTarget('campaign-1', 't1')).toHaveLength(1);
    expect(store.listByTarget('campaign-1', 't2')).toHaveLength(1);
    expect(store.listByTarget('campaign-2', 't1')).toHaveLength(1);
  });

  // "Does this ever create a RunStep" is verified for real by the law
  // redteam.frozen/meta-harness-does-not-create-runstep (src/laws/catalog/shadow.laws.ts),
  // which checks RunStepStore's row count empirically rather than a token import
  // check here that would prove nothing about runtime behavior.
});
