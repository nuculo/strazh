#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db/connection.js';
import { CampaignEventStore } from '../events/store.js';
import { RunStepStore } from '../runsteps/store.js';
import { runPlannerOnce, type PlannerRunConfig } from './run-once.js';
import { AssessmentRunStore } from './assessment-run-store.js';
import type { ProbeCatalogEntry } from '../candidates/catalog.js';

/**
 * The production entrypoint the mixer/dispatch pipeline never had:
 * `tsx src/planner/cli.ts --db=... --campaign-id=... --target-id=... --assessment-run-id=... --config=...`
 * enumerates eligible candidates for one Target against a real event-sourced
 * CampaignWorld, ranks them (heuristic always, a configured model only if its
 * `ModelPromotionRegistry` state permits — see `runPlannerOnce()`), mixes them
 * under `PlannerPolicy`, and dispatches the result to durable RunSteps. Same
 * argv/config-file shape `worker/cli.ts` established; the testable composition
 * lives in `run-once.ts`, same split as `worker/promptfoo-worker.ts` vs.
 * `worker/cli.ts`.
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

function fail(configPath: string, message: string): never {
  console.error(`${configPath}: ${message}`);
  process.exit(1);
}

function validateConfig(raw: unknown, configPath: string): PlannerRunConfig {
  if (typeof raw !== 'object' || raw === null) {
    fail(configPath, 'did not contain a JSON object');
  }
  const c = raw as Record<string, unknown>;

  if (!Array.isArray(c.catalog) || c.catalog.length === 0) {
    fail(configPath, '"catalog" must be a non-empty array');
  }
  const catalog: ProbeCatalogEntry[] = (c.catalog as unknown[]).map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.probeId !== 'string' || e.probeId === '' || typeof e.mandatory !== 'boolean') {
      fail(configPath, `"catalog[${i}]" must be {probeId: non-empty string, mandatory: boolean}`);
    }
    return { probeId: e.probeId as string, mandatory: e.mandatory as boolean };
  });

  const p = c.policy as Record<string, unknown> | undefined;
  if (
    typeof p !== 'object' ||
    p === null ||
    typeof p.policyVersion !== 'string' ||
    p.policyVersion === '' ||
    typeof p.modelShareCap !== 'number' ||
    typeof p.explorationShare !== 'number' ||
    typeof p.maxBatchSize !== 'number'
  ) {
    fail(configPath, '"policy" must be {policyVersion: string, modelShareCap: number, explorationShare: number, maxBatchSize: number}');
  }
  const policy: PlannerRunConfig['policy'] = {
    policyVersion: p.policyVersion as string,
    modelShareCap: p.modelShareCap as number,
    explorationShare: p.explorationShare as number,
    maxBatchSize: p.maxBatchSize as number,
  };

  let eligibility: PlannerRunConfig['eligibility'];
  if (c.eligibility !== undefined) {
    const el = c.eligibility as Record<string, unknown>;
    if (typeof el.maxAttemptsPerProbe !== 'number' || typeof el.excludeConfirmedVulnerable !== 'boolean') {
      fail(configPath, '"eligibility", if present, must be {maxAttemptsPerProbe: number, excludeConfirmedVulnerable: boolean}');
    }
    eligibility = { maxAttemptsPerProbe: el.maxAttemptsPerProbe as number, excludeConfirmedVulnerable: el.excludeConfirmedVulnerable as boolean };
  }

  let model: PlannerRunConfig['model'];
  if (c.model !== undefined) {
    const m = c.model as Record<string, unknown>;
    const w = m.weights as Record<string, unknown> | undefined;
    if (
      typeof m.modelRef !== 'string' ||
      m.modelRef === '' ||
      typeof w !== 'object' ||
      w === null ||
      w.kind !== 'linear-regression' ||
      !Array.isArray(w.weights) ||
      !w.weights.every((x) => typeof x === 'number') ||
      typeof w.bias !== 'number'
    ) {
      fail(configPath, '"model", if present, must be {modelRef: string, weights: {kind: "linear-regression", weights: number[], bias: number}}');
    }
    model = { modelRef: m.modelRef as string, weights: { weights: w.weights as number[], bias: w.bias as number } };
  }

  return {
    catalog,
    policy,
    ...(eligibility !== undefined ? { eligibility } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

const dbPath = requireFlag('db');
const campaignId = requireFlag('campaign-id');
const targetId = requireFlag('target-id');
const assessmentRunId = requireFlag('assessment-run-id');
const configPath = requireFlag('config');

const rawConfig: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
const config = validateConfig(rawConfig, configPath);

const db = openDatabase(dbPath);
const events = new CampaignEventStore(db);
const runSteps = new RunStepStore(db);
const assessmentRuns = new AssessmentRunStore(db);

// грань №20: the one real delivery surface for the planner — start() before
// runPlannerOnce() every invocation. Idempotent: a repeated run for the same
// assessmentRunId/campaignId is a no-op.
assessmentRuns.start(assessmentRunId, campaignId);

const report = runPlannerOnce({ db, events, runSteps, assessmentRuns }, config, { campaignId, targetId, assessmentRunId });

console.log(`intelligence: ${report.intelligenceStatus}`);
console.log(`model: ${config.model?.modelRef ?? '(none configured)'} state=${report.modelState} ranked=${report.modelRankedCount} influencedDispatch=${report.modelInfluencedDispatch}`);
if (report.modelSkipReason) {
  console.log(`model skipped: ${report.modelSkipReason}`);
}
console.log(
  `mix: mandatory=${report.mix.armCounts.mandatory} model=${report.mix.armCounts.model} heuristic=${report.mix.armCounts.heuristic} exploration=${report.mix.armCounts.exploration}` +
    (report.mix.mandatoryShortfall.length > 0 ? ` mandatoryShortfall=${report.mix.mandatoryShortfall.length}` : '') +
    (report.mix.staleModelRecommendationsDropped > 0 ? ` staleModelRecommendationsDropped=${report.mix.staleModelRecommendationsDropped}` : ''),
);
for (const d of report.dispatched) {
  console.log(`${d.runStepId}: ${d.arm}${d.deduped ? ' (deduped)' : ''}`);
}
console.log(`${report.dispatched.length} RunStep(s) dispatched for ${assessmentRunId}.`);

process.exit(0);
