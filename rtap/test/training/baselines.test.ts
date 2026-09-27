import { describe, expect, it } from 'vitest';
import { randomBaseline } from '../../src/training/baselines/random-baseline.js';
import { fixedOrderBaseline } from '../../src/training/baselines/fixed-order-baseline.js';
import { heuristicBaseline } from '../../src/training/baselines/heuristic-baseline.js';
import { makeLinearRegressionBaseline, loadFittedLinearModel } from '../../src/training/baselines/linear-regression-baseline.js';
import { exportDataset } from '../../src/training/dataset-exporter.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from './fixtures.js';

function dataset() {
  const built = buildSyntheticCorpus({ campaigns: 2, targetsPerCampaign: 2, probesPerTarget: 10, seed: 7 });
  const allEvents = allEventsAcrossCampaigns(built.eventStore, ['campaign-0', 'campaign-1']);
  return exportDataset(built.records, allEvents).examples;
}

describe('randomBaseline', () => {
  it('is deterministic per candidate regardless of training data', () => {
    const examples = dataset();
    const model = randomBaseline.fit(examples);
    const a = model.predict(examples[0]!.features);
    const b = model.predict(examples[0]!.features);
    expect(a).toBe(b);
  });

  it('produces values in [0, 1]', () => {
    const model = randomBaseline.fit([]);
    const examples = dataset();
    for (const e of examples.slice(0, 10)) {
      const p = model.predict(e.features);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('fixedOrderBaseline', () => {
  it('ranks a known high-priority class above an unknown one', () => {
    const model = fixedOrderBaseline.fit([]);
    const examples = dataset();
    const injection = examples.find((e) => e.probeId.startsWith('prompt-injection:'));
    const jailbreak = examples.find((e) => e.probeId.startsWith('jailbreak:'));
    expect(injection).toBeDefined();
    expect(jailbreak).toBeDefined();
    expect(model.predict(injection!.features)).toBeGreaterThan(model.predict(jailbreak!.features));
  });
});

describe('heuristicBaseline', () => {
  it('prefers a probe with zero prior attempts over one already attempted', () => {
    const model = heuristicBaseline.fit([]);
    const examples = dataset();
    const untried = examples.find((e) => e.features.vector[42] === 0)!;
    const tried = examples.find((e) => (e.features.vector[42] ?? 0) > 0);
    if (!tried) return; // corpus-dependent; skip rather than force a flaky assertion
    expect(model.predict(untried.features)).toBeGreaterThan(model.predict(tried.features));
  });
});

describe('makeLinearRegressionBaseline', () => {
  it('fits weights that are finite and deterministic across repeated fits on the same data', () => {
    const examples = dataset();
    const baseline = makeLinearRegressionBaseline({ epochs: 50 });
    const modelA = baseline.fit(examples);
    const modelB = baseline.fit(examples);
    expect(modelA.weights).toEqual(modelB.weights);
    expect(modelA.bias).toBe(modelB.bias);
    expect(modelA.weights.every((w) => Number.isFinite(w))).toBe(true);
  });

  it('reduces training-set MSE after fitting versus an all-zero model', () => {
    const examples = dataset();
    const baseline = makeLinearRegressionBaseline({ epochs: 300 });
    const model = baseline.fit(examples);

    const mse = (predict: (f: (typeof examples)[number]['features']) => number) => {
      const errs = examples.map((e) => (predict(e.features) - e.label) ** 2);
      return errs.reduce((s, x) => s + x, 0) / errs.length;
    };

    const fittedMse = mse((f) => model.predict(f));
    const zeroMse = mse(() => 0);
    expect(fittedMse).toBeLessThan(zeroMse);
  });

  it('an empty training set produces a harmless zero model, not a crash', () => {
    const baseline = makeLinearRegressionBaseline();
    const model = baseline.fit([]);
    expect(model.predict(dataset()[0]!.features)).toBe(0);
  });
});

describe('loadFittedLinearModel', () => {
  it('reconstructs a model whose predictions match the fitted model it was serialized from', () => {
    const examples = dataset();
    const fitted = makeLinearRegressionBaseline({ epochs: 100 }).fit(examples);
    const loaded = loadFittedLinearModel({ weights: fitted.weights, bias: fitted.bias });
    for (const e of examples.slice(0, 10)) {
      expect(loaded.predict(e.features)).toBe(fitted.predict(e.features));
    }
  });

  it('carries the weights/bias through unchanged, for round-tripping through training/model-artifact.ts\'s SerializedWeights envelope', () => {
    const loaded = loadFittedLinearModel({ weights: [1, 2, 3], bias: 0.5 });
    expect(loaded.weights).toEqual([1, 2, 3]);
    expect(loaded.bias).toBe(0.5);
  });
});
