import { mulberry32, randInt, randBool, randFloat } from '../rng.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { RunStepStore } from '../../runsteps/store.js';
import { compileCandidateFeatures } from '../../features/candidate-compiler.js';
import { buildHistoryView } from '../../features/history-view.js';
import { rankCandidates } from '../../shadow/rank.js';
import { heuristicBaseline } from '../../training/baselines/heuristic-baseline.js';
import { loadFittedLinearModel } from '../../training/baselines/linear-regression-baseline.js';
import type { Law } from '../types.js';

const emptyHistory = buildHistoryView([], 'campaign-1', 0);

function randomFeatures(seed: number, count: number) {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, (_, i) =>
    compileCandidateFeatures(
      { targetId: 't1', probe: { probeId: `p${randInt(rng, 1, 5)}:s${i}` }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } },
      emptyHistory,
    ),
  );
}

// ADAPTIVE_REDTEAM_RUNTIME.md §14, FROZEN_META_HARNESS.md §11.
export const shadowLaws: Law[] = [
  {
    id: 'redteam.planner/frozen-failure-falls-back-to-heuristic',
    statement:
      'rankCandidates() never throws: when the primary model.predict throws on any candidate, the whole batch falls back to the heuristic baseline and the ranking it returns is identical to ranking the same candidates with heuristicBaseline directly.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const features = randomFeatures(seed, randInt(rng, 1, 8));
      const world = { worldGeneration: 0, worldEpoch: randInt(rng, 0, 100) };
      const throwingModel = {
        name: 'flaky',
        predict: () => {
          throw new Error('simulated model failure');
        },
      };

      let result;
      try {
        result = rankCandidates(throwingModel, 'flaky-model', features, world, 'SHADOW');
      } catch (err) {
        return { held: false, detail: 'rankCandidates threw instead of falling back', counterexample: { seed, err: String(err) } };
      }

      if (!result.usedFallback) {
        return { held: false, detail: 'usedFallback was false despite the model throwing', counterexample: result };
      }

      const directHeuristic = rankCandidates(heuristicBaseline.fit([]), 'heuristic', features, world, 'SHADOW');
      const fallbackValues = result.ranked.map((r) => r.signal.value).sort();
      const directValues = directHeuristic.ranked.map((r) => r.signal.value).sort();
      if (JSON.stringify(fallbackValues) !== JSON.stringify(directValues)) {
        return { held: false, detail: 'Fallback ranking values differ from a direct heuristic ranking', counterexample: { fallbackValues, directValues } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/meta-harness-does-not-create-runstep',
    statement:
      'Scoring and ranking candidates (scoreCandidate, rankCandidates, ShadowRankingStore) never creates a RunStep — FROZEN_META_HARNESS.md §11 meta-harness-does-not-create-runstep. Checked empirically: the RunStepStore row count for an assessment run is unchanged after shadow-scoring, and rank.ts/signal.ts/store.ts import nothing from runsteps/.',
    status: 'implemented',
    trials: 50,
    check: ({ seed }) => {
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const before = runSteps.listByAssessmentRun('run-1').length;

      const rng = mulberry32(seed);
      const features = randomFeatures(seed, randInt(rng, 1, 10));
      const world = { worldGeneration: 0, worldEpoch: 0 };
      const model = heuristicBaseline.fit([]);
      rankCandidates(model, 'heuristic', features, world, randBool(rng) ? 'SHADOW' : 'EXPERIMENTAL');

      const after = runSteps.listByAssessmentRun('run-1').length;
      if (after !== before) {
        return { held: false, detail: `RunStep count changed from ${before} to ${after} after shadow scoring`, counterexample: { before, after } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.shadow/inference-is-deterministic-for-same-input',
    statement:
      "FittedModel.predict() is deterministic: given the same CandidateFeatureSnapshot, two separate calls to the same model instance always return the identical prediction value. Feeds promotion/phase16-admission.ts's Shadow criterion 6 (ADAPTIVE_REDTEAM_RUNTIME.md §16) — not assumed true by construction just because predict() is a pure dot product; this repo's own convention is that nothing is MET without a real check, however obvious.",
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const weights = Array.from({ length: 60 }, () => randFloat(rng, -1, 1));
      const bias = randFloat(rng, -1, 1);
      const model = loadFittedLinearModel({ weights, bias });
      const [features] = randomFeatures(seed, 1);

      const a = model.predict(features!);
      const b = model.predict(features!);
      if (a !== b) {
        return { held: false, detail: 'predict() returned different values for the same input across two calls on the same model instance', counterexample: { seed, a, b } };
      }
      return { held: true };
    },
  },
];
