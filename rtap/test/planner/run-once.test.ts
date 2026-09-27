import { describe, expect, it } from 'vitest';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ModelPromotionRegistry } from '../../src/promotion/registry.js';
import { exportDataset } from '../../src/training/dataset-exporter.js';
import { makeLinearRegressionBaseline } from '../../src/training/baselines/linear-regression-baseline.js';
import { packageLinearModelArtifact } from '../../src/training/model-artifact.js';
import type { ProbeCatalogEntry } from '../../src/candidates/catalog.js';
import { runPlannerOnce, type PlannerRunConfig, type PlannerRunDeps } from '../../src/planner/run-once.js';
import { AssessmentRunStore } from '../../src/planner/assessment-run-store.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from '../training/fixtures.js';
import { signAndGate } from '../promotion/signing-fixture.js';

const TARGET_ID = 'campaign-0-target-0';

function setup(seed = 91) {
  const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 12, seed });
  const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);
  const { examples } = exportDataset(corpus.records, allEvents);
  const fittedModel = makeLinearRegressionBaseline({ epochs: 100 }).fit(examples);

  const runSteps = new RunStepStore(corpus.db);
  const registry = new ModelPromotionRegistry(corpus.db);

  const catalog: ProbeCatalogEntry[] = [
    { probeId: 'mandatory-coverage:default', mandatory: true },
    ...[...new Set(examples.map((e) => e.probeId))].map((probeId) => ({ probeId, mandatory: false })),
  ];

  const deps: PlannerRunDeps = { db: corpus.db, events: corpus.eventStore, runSteps };
  return { deps, registry, fittedModel, catalog, featureSchemaVersion: examples[0]!.features.featureSchemaVersion };
}

async function promoteTo(
  registry: ModelPromotionRegistry,
  fittedModel: { weights: readonly number[]; bias: number },
  modelRef: string,
  featureSchemaVersion: string,
  to: 'SHADOW' | 'EXPERIMENTAL' | 'CALIBRATED',
  taxonomyVersion = 'taxonomy-v1',
): Promise<void> {
  const artifact = packageLinearModelArtifact(fittedModel, {
    modelRef,
    featureSchemaVersion,
    taxonomyVersion,
    trainingDatasetRef: 'planner-cli-test',
    benchmarkRef: 'planner-cli-test',
    issuer: 'test',
  });
  const { signed, gate } = await signAndGate(artifact);
  registry.admit(signed);
  registry.applyEvent(modelRef, 'MODEL_ADMITTED', gate); // OFF -> SHADOW
  if (to === 'SHADOW') return;
  registry.applyEvent(modelRef, 'OFFLINE_AND_SHADOW_GATES_PASSED'); // SHADOW -> EXPERIMENTAL
  if (to === 'EXPERIMENTAL') return;
  // грань №18: AB_GATES_PASSED is now signature-gated too — same artifact, same gate.
  registry.applyEvent(modelRef, 'AB_GATES_PASSED', gate); // EXPERIMENTAL -> CALIBRATED
}

const POLICY = { policyVersion: 'planner-cli-test-1', modelShareCap: 0.1, explorationShare: 0.15, maxBatchSize: 20 };
const PERMISSIVE_ELIGIBILITY = { maxAttemptsPerProbe: 5, excludeConfirmedVulnerable: false };
const FIXED_RNG = () => 0.42;

describe('runPlannerOnce', () => {
  it('with no model configured, dispatches a real mandatory+heuristic+exploration batch to durable RunSteps', () => {
    const { deps, catalog } = setup();
    const config: PlannerRunConfig = { catalog, policy: POLICY, eligibility: PERMISSIVE_ELIGIBILITY };

    const report = runPlannerOnce(deps, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelState).toBe('OFF');
    expect(report.modelRankedCount).toBe(0);
    expect(report.modelInfluencedDispatch).toBe(false);
    expect(report.mix.armCounts.model).toBe(0);
    expect(report.mix.decisions.some((d) => d.arm === 'mandatory')).toBe(true);
    expect(report.dispatched.length).toBe(report.mix.decisions.length);
    expect(report.dispatched.length).toBeGreaterThan(0);
    expect(report.modelSkipReason).toBeNull();
    // грань №20: no model arm ranked, so nothing could have fallen back.
    expect(report.intelligenceStatus).toBe('HEALTHY');
    // No AssessmentRunStore.start() was called for this assessmentRunId (deps
    // carries no assessmentRuns, and this test never touches one) — recording is a
    // tolerated no-op, not an error.
    expect(report.intelligenceStatusRecorded).toBe(false);

    const rows = deps.runSteps.listByAssessmentRun('run-1');
    expect(rows.length).toBe(report.dispatched.length);
  });

  it('грань №20: when AssessmentRunStore.start() was called first, a HEALTHY run is durably recorded', () => {
    const { deps, catalog } = setup();
    const assessmentRuns = new AssessmentRunStore(deps.db);
    assessmentRuns.start('run-1', 'campaign-0', new Date(0));
    const config: PlannerRunConfig = { catalog, policy: POLICY, eligibility: PERMISSIVE_ELIGIBILITY };

    const report = runPlannerOnce({ ...deps, assessmentRuns }, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.intelligenceStatus).toBe('HEALTHY');
    expect(report.intelligenceStatusRecorded).toBe(true);
    expect(assessmentRuns.get('run-1')?.intelligenceStatus).toBe('HEALTHY');
    expect(assessmentRuns.get('run-1')?.everDegradedAt).toBeNull();
  });

  it('a model configured but never admitted to the ModelPromotionRegistry is treated as OFF, not trusted from config', () => {
    const { deps, catalog, fittedModel } = setup();
    const config: PlannerRunConfig = {
      catalog,
      policy: POLICY,
      eligibility: PERMISSIVE_ELIGIBILITY,
      model: { modelRef: 'never-admitted-v1', weights: { weights: fittedModel.weights, bias: fittedModel.bias } },
    };

    const report = runPlannerOnce(deps, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelState).toBe('OFF');
    expect(report.modelRankedCount).toBe(0);
    expect(report.mix.armCounts.model).toBe(0);
    expect(report.modelSkipReason).toContain('never-admitted-v1');
    expect(report.modelSkipReason).toContain('never admitted');
  });

  it('a model registered with a featureSchemaVersion that does not match the compiler\'s current FEATURE_SCHEMA_VERSION is refused, even though its promotion state would otherwise permit it', async () => {
    const { deps, registry, catalog, fittedModel } = setup();
    await promoteTo(registry, fittedModel, 'stale-schema-model-v1', '0.0.1', 'EXPERIMENTAL');
    const config: PlannerRunConfig = {
      catalog,
      policy: POLICY,
      eligibility: PERMISSIVE_ELIGIBILITY,
      model: { modelRef: 'stale-schema-model-v1', weights: { weights: fittedModel.weights, bias: fittedModel.bias } },
    };

    const report = runPlannerOnce(deps, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelState).toBe('EXPERIMENTAL'); // promotion state itself is fine...
    expect(report.modelRankedCount).toBe(0); // ...but it was never even ranked
    expect(report.modelInfluencedDispatch).toBe(false);
    expect(report.mix.armCounts.model).toBe(0);
    expect(report.modelSkipReason).toContain('0.0.1');
    expect(report.modelSkipReason).toContain('featureSchemaVersion');
  });

  it('a model registered with a mismatched taxonomyVersion is refused even when featureSchemaVersion matches — CANDIDATE_TAXONOMY_VERSION is checked independently', async () => {
    const { deps, registry, catalog, fittedModel, featureSchemaVersion } = setup();
    await promoteTo(registry, fittedModel, 'stale-taxonomy-model-v1', featureSchemaVersion, 'EXPERIMENTAL', 'taxonomy-v2');
    const config: PlannerRunConfig = {
      catalog,
      policy: POLICY,
      eligibility: PERMISSIVE_ELIGIBILITY,
      model: { modelRef: 'stale-taxonomy-model-v1', weights: { weights: fittedModel.weights, bias: fittedModel.bias } },
    };

    const report = runPlannerOnce(deps, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelState).toBe('EXPERIMENTAL');
    expect(report.modelRankedCount).toBe(0);
    expect(report.modelInfluencedDispatch).toBe(false);
    expect(report.mix.armCounts.model).toBe(0);
    expect(report.modelSkipReason).toContain('taxonomy-v2');
    expect(report.modelSkipReason).toContain('taxonomyVersion');
    expect(report.modelSkipReason).not.toContain('featureSchemaVersion (registered'); // the schema half matched — only taxonomy should be named as mismatched
  });

  it('a model mismatched on both featureSchemaVersion and taxonomyVersion reports both reasons', async () => {
    const { deps, registry, catalog, fittedModel } = setup();
    await promoteTo(registry, fittedModel, 'stale-both-model-v1', '0.0.1', 'EXPERIMENTAL', 'taxonomy-v2');
    const config: PlannerRunConfig = {
      catalog,
      policy: POLICY,
      eligibility: PERMISSIVE_ELIGIBILITY,
      model: { modelRef: 'stale-both-model-v1', weights: { weights: fittedModel.weights, bias: fittedModel.bias } },
    };

    const report = runPlannerOnce(deps, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelRankedCount).toBe(0);
    expect(report.modelSkipReason).toContain('featureSchemaVersion');
    expect(report.modelSkipReason).toContain('taxonomyVersion');
  });

  it('SHADOW ranks and could be logged, but authorityFor().influencesRunStepCreation === false keeps it out of dispatch — Phase 3\'s own line, enforced here', async () => {
    const { deps, registry, catalog, fittedModel, featureSchemaVersion } = setup();
    await promoteTo(registry, fittedModel, 'shadow-model-v1', featureSchemaVersion, 'SHADOW');
    const config: PlannerRunConfig = {
      catalog,
      policy: POLICY,
      eligibility: PERMISSIVE_ELIGIBILITY,
      model: { modelRef: 'shadow-model-v1', weights: { weights: fittedModel.weights, bias: fittedModel.bias } },
    };

    const report = runPlannerOnce(deps, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelState).toBe('SHADOW');
    expect(report.modelRankedCount).toBeGreaterThan(0); // it was ranked...
    expect(report.modelInfluencedDispatch).toBe(false); // ...but never reached the mixer
    expect(report.mix.armCounts.model).toBe(0);
    expect(report.mix.decisions.some((d) => d.arm === 'model')).toBe(false);
    // modelSkipReason only fires when ranking itself was refused — SHADOW *was*
    // ranked, it just never reached the mixer, so there is nothing to report here.
    expect(report.modelSkipReason).toBeNull();
  });

  it('EXPERIMENTAL influences dispatch and stays bounded by policy.modelShareCap — authorityFor().boundedShare === true', async () => {
    const { deps, registry, catalog, fittedModel, featureSchemaVersion } = setup();
    await promoteTo(registry, fittedModel, 'exp-model-v1', featureSchemaVersion, 'EXPERIMENTAL');
    const config: PlannerRunConfig = {
      catalog,
      policy: POLICY,
      eligibility: PERMISSIVE_ELIGIBILITY,
      model: { modelRef: 'exp-model-v1', weights: { weights: fittedModel.weights, bias: fittedModel.bias } },
    };

    const report = runPlannerOnce({ ...deps, rng: FIXED_RNG }, config, { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' }, new Date());

    expect(report.modelState).toBe('EXPERIMENTAL');
    expect(report.modelInfluencedDispatch).toBe(true);
    expect(report.mix.armCounts.model).toBeGreaterThan(0);
    expect(report.dispatched.some((d) => d.arm === 'model')).toBe(true);
    expect(report.modelSkipReason).toBeNull();
    // A model-arm decision now carries real RecommendationProvenance — every prior
    // mixer.ts caller passed no CampaignWorldState in, so this was always null before.
    const modelDecision = report.mix.decisions.find((d) => d.arm === 'model')!;
    expect(modelDecision.provenance).not.toBeNull();
    expect(modelDecision.provenance!.compilerDigest).toBe('candidate-fc-v1');
  });

  it('CALIBRATED lifts the modelShareCap bound (authorityFor().boundedShare === false) — the same policy admits more of the batch than under EXPERIMENTAL', async () => {
    const experimental = setup();
    await promoteTo(experimental.registry, experimental.fittedModel, 'ab-model-v1', experimental.featureSchemaVersion, 'EXPERIMENTAL');
    const experimentalReport = runPlannerOnce(
      { ...experimental.deps, rng: FIXED_RNG },
      { catalog: experimental.catalog, policy: POLICY, eligibility: PERMISSIVE_ELIGIBILITY, model: { modelRef: 'ab-model-v1', weights: { weights: experimental.fittedModel.weights, bias: experimental.fittedModel.bias } } },
      { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' },
      new Date(),
    );

    const calibrated = setup();
    await promoteTo(calibrated.registry, calibrated.fittedModel, 'ab-model-v1', calibrated.featureSchemaVersion, 'CALIBRATED');
    const calibratedReport = runPlannerOnce(
      { ...calibrated.deps, rng: FIXED_RNG },
      { catalog: calibrated.catalog, policy: POLICY, eligibility: PERMISSIVE_ELIGIBILITY, model: { modelRef: 'ab-model-v1', weights: { weights: calibrated.fittedModel.weights, bias: calibrated.fittedModel.bias } } },
      { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' },
      new Date(),
    );

    expect(calibratedReport.modelState).toBe('CALIBRATED');
    expect(calibratedReport.mix.armCounts.model).toBeGreaterThan(experimentalReport.mix.armCounts.model);
  });

  it('re-dispatching the same decisions is idempotent — the second call dedupes against the first, RunStepStore does not grow', () => {
    const { deps, catalog } = setup();
    const config: PlannerRunConfig = { catalog, policy: POLICY, eligibility: PERMISSIVE_ELIGIBILITY };
    const ctx = { campaignId: 'campaign-0', targetId: TARGET_ID, assessmentRunId: 'run-1' };
    const runDeps = { ...deps, rng: FIXED_RNG };

    const first = runPlannerOnce(runDeps, config, ctx, new Date());
    const before = deps.runSteps.listByAssessmentRun('run-1').length;

    const second = runPlannerOnce(runDeps, config, ctx, new Date());
    const after = deps.runSteps.listByAssessmentRun('run-1').length;

    expect(first.dispatched.every((d) => !d.deduped)).toBe(true);
    expect(second.dispatched.every((d) => d.deduped)).toBe(true);
    expect(after).toBe(before);
  });
});
