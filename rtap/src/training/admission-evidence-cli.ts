#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { splitByTarget, splitByCampaign, splitByTime, splitByVulnerabilityClass, checkNoLeakage, type SplitResult } from './splits.js';
import { vulnerabilityClassOf } from '../features/history-view.js';
import { evaluate } from './evaluate.js';
import { evaluateAdmissionGate } from './admission-gate.js';
import { randomBaseline } from './baselines/random-baseline.js';
import { fixedOrderBaseline } from './baselines/fixed-order-baseline.js';
import { heuristicBaseline } from './baselines/heuristic-baseline.js';
import { loadFittedLinearModel } from './baselines/linear-regression-baseline.js';
import type { TrainingExample } from './dataset-exporter.js';

/**
 * `promotion/phase16-admission.ts`'s `Phase16Evidence.datasetLeakageCheck`/
 * `.baselineComparison` are real computed results, not declared booleans — but
 * `promotion/cli.ts admission` deliberately doesn't compute them itself (its own
 * doc comment: "this CLI does not recompute checkNoLeakage()/evaluateAdmissionGate()
 * itself"). This is that computation, as its own small tool, emitting exactly the
 * two-field JSON shape an operator merges into (or uses directly as) an
 * `--evidence=` file for `promotion/cli.ts admission`.
 *
 *   tsx src/training/admission-evidence-cli.ts \
 *     --dataset=<path to TrainingExample[] JSON> \
 *     --split=target|campaign|vulnerability-class|time \
 *     --holdout=<comma-separated group ids>   (target/campaign/vulnerability-class)
 *     --holdout-cutoff=<ISO8601>               (time)
 *     --model-config=<path to {kind, weights, bias} JSON> \
 *     [--model-name=<string, default "candidate">] \
 *     [--out=<path>, default: print to stdout]
 *
 * Takes an already-exported `TrainingExample[]` (`--dataset=`), not a live
 * database — `training/dataset-exporter.ts`'s `exportDataset()` itself has no
 * production caller anywhere in this repo yet (only `test/training/fixtures.ts`'s
 * synthetic corpus exercises it); assembling real `HistoricalRecord[]` from
 * `ObservationStore`/`CampaignEventStore` is a genuine, separate gap this tool does
 * not close. See its own "What's honestly not here" in rtap/README.md.
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function requireFlag(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`missing required --${name}=...`);
    process.exit(1);
  }
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const VALID_SPLITS = ['target', 'campaign', 'vulnerability-class', 'time'] as const;
type SplitStrategy = (typeof VALID_SPLITS)[number];

function validateDataset(raw: unknown, datasetPath: string): TrainingExample[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`${datasetPath}: must be a non-empty JSON array of TrainingExample`);
  }
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (
      typeof e.campaignId !== 'string' ||
      e.campaignId === '' ||
      typeof e.targetId !== 'string' ||
      e.targetId === '' ||
      typeof e.probeId !== 'string' ||
      e.probeId === '' ||
      typeof e.occurredAt !== 'string' ||
      e.occurredAt === '' ||
      typeof e.label !== 'number'
    ) {
      fail(`${datasetPath}: examples[${i}] must have non-empty string campaignId/targetId/probeId/occurredAt and a numeric label`);
    }
    const f = e.features as Record<string, unknown> | undefined;
    if (typeof f !== 'object' || f === null || !Array.isArray(f.vector) || !f.vector.every((x) => typeof x === 'number')) {
      fail(`${datasetPath}: examples[${i}].features must be an object with a numeric "vector" array`);
    }
    return entry as TrainingExample;
  });
}

function buildSplit(strategy: SplitStrategy, examples: readonly TrainingExample[]): { split: SplitResult; groupOf: (e: TrainingExample) => string } {
  switch (strategy) {
    case 'target': {
      const holdout = new Set(requireFlag('holdout').split(','));
      return { split: splitByTarget(examples, holdout), groupOf: (e) => e.targetId };
    }
    case 'campaign': {
      const holdout = new Set(requireFlag('holdout').split(','));
      return { split: splitByCampaign(examples, holdout), groupOf: (e) => e.campaignId };
    }
    case 'vulnerability-class': {
      const holdout = new Set(requireFlag('holdout').split(','));
      return { split: splitByVulnerabilityClass(examples, holdout), groupOf: (e) => vulnerabilityClassOf(e.probeId) };
    }
    case 'time': {
      const cutoff = requireFlag('holdout-cutoff');
      // No single identity is "the" leakage concern for a temporal holdout by
      // construction (the same target legitimately has examples on both sides of
      // the cutoff — that is what a time split is for). targetId is the most
      // operationally meaningful group to still check for accidental full-target
      // leakage against (a target with zero pre-cutoff history at all).
      return { split: splitByTime(examples, cutoff), groupOf: (e) => e.targetId };
    }
  }
}

const datasetPath = requireFlag('dataset');
const splitRaw = requireFlag('split');
if (!(VALID_SPLITS as readonly string[]).includes(splitRaw)) {
  fail(`--split must be one of ${VALID_SPLITS.join(', ')}, got "${splitRaw}"`);
}
const splitStrategy = splitRaw as SplitStrategy;
const modelConfigPath = requireFlag('model-config');
const modelName = flag('model-name') ?? 'candidate';
const outPath = flag('out');

const dataset = validateDataset(JSON.parse(readFileSync(datasetPath, 'utf-8')), datasetPath);
const { split, groupOf } = buildSplit(splitStrategy, dataset);
if (split.holdout.length === 0) {
  fail(`--split=${splitStrategy}: the holdout side is empty — check --holdout/--holdout-cutoff actually match examples in ${datasetPath}`);
}

const rawModelConfig = JSON.parse(readFileSync(modelConfigPath, 'utf-8')) as Record<string, unknown>;
const w = rawModelConfig.weights as Record<string, unknown> | undefined;
if (
  rawModelConfig.kind !== 'linear-regression' ||
  typeof w !== 'object' ||
  w === null ||
  !Array.isArray(w.weights) ||
  !w.weights.every((x) => typeof x === 'number') ||
  typeof w.bias !== 'number'
) {
  fail(`${modelConfigPath}: must be {kind: "linear-regression", weights: {weights: number[], bias: number}}`);
}
const model = loadFittedLinearModel({ weights: w.weights as number[], bias: w.bias as number });

const datasetLeakageCheck = checkNoLeakage(split, groupOf);

const candidateEval = { ...evaluate(model, split.holdout), modelName };
const baselineEvals = [randomBaseline, fixedOrderBaseline, heuristicBaseline].map((b) => evaluate(b.fit(split.train), split.holdout));
const baselineComparison = evaluateAdmissionGate(candidateEval, baselineEvals);

const evidence = { datasetLeakageCheck, baselineComparison };
const output = JSON.stringify(evidence, null, 2);

if (outPath) {
  writeFileSync(outPath, output + '\n');
  console.error(`wrote ${outPath}`);
} else {
  console.log(output);
}

process.exit(0);
