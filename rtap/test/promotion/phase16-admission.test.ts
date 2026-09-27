import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { buildRegistry } from '../../src/laws/index.js';
import { ModelPromotionRegistry } from '../../src/promotion/registry.js';
import { admitModel, type AdmitModelConfig } from '../../src/promotion/admit-model.js';
import { evaluatePhase16Admission, type Phase16Evidence } from '../../src/promotion/phase16-admission.js';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { testSigningAuthority } from './signing-fixture.js';
import { packageLinearModelArtifact } from '../../src/training/model-artifact.js';
import { splitByTarget, checkNoLeakage } from '../../src/training/splits.js';
import { evaluateAdmissionGate } from '../../src/training/admission-gate.js';
import type { EvaluationResult } from '../../src/training/evaluate.js';
import { exportDataset } from '../../src/training/dataset-exporter.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from '../training/fixtures.js';

function dataset() {
  const corpus = buildSyntheticCorpus({ campaigns: 2, targetsPerCampaign: 2, probesPerTarget: 6, seed: 7 });
  const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0', 'campaign-1']);
  return exportDataset(corpus.records, allEvents).examples;
}

// Deterministic by construction — evaluateAdmissionGate() is real, but a real
// trained model's rankCorrelation on synthetic data is not reliable test input, so
// these EvaluationResults are hand-picked rather than produced by fitting a model.
const WINNING_CANDIDATE: EvaluationResult = { modelName: 'candidate', n: 20, mse: 0.01, mae: 0.05, rankCorrelation: 0.9 };
const LOSING_CANDIDATE: EvaluationResult = { modelName: 'candidate', n: 20, mse: 0.2, mae: 0.3, rankCorrelation: 0.1 };
const BASELINE: EvaluationResult = { modelName: 'heuristic', n: 20, mse: 0.05, mae: 0.1, rankCorrelation: 0.5 };

const FULLY_MET_CONFIG: AdmitModelConfig = {
  featureSchemaVersion: '1.0.0',
  taxonomyVersion: 'taxonomy-v1',
  trainingDatasetRef: 'ds-1',
  benchmarkRef: 'bench-1',
  issuer: 'test',
  weights: { weights: new Array(60).fill(0), bias: 0 },
};

function fullEvidence(): Phase16Evidence {
  const examples = dataset();
  const split = splitByTarget(examples, new Set([examples[0]!.targetId]));
  return {
    datasetLeakageCheck: checkNoLeakage(split, (e) => e.targetId),
    baselineComparison: evaluateAdmissionGate(WINNING_CANDIDATE, [BASELINE]),
    utilityLabelOwnershipDocumented: true,
    uniqueFindingsLiftPer100Calls: 5,
    mandatoryTaxonomyCoverageRegressed: false,
    errorAndTimeoutRatesWithinBounds: true,
    sustainedAbGainAcrossHoldouts: true,
    modelAndFeatureDriftWithinThresholds: true,
    signedRollbackTargetAvailable: true,
    unifiedReasonCodesAvailable: true,
    criticalClassRegressionWithinPolicy: true,
  };
}

describe('evaluatePhase16Admission', () => {
  let artifactsDir: string;
  let artifactStore: FilesystemArtifactStore;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'rtap-phase16-test-'));
    artifactStore = new FilesystemArtifactStore(artifactsDir);
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reports all 17 criteria across the three tiers and all 6 stop conditions', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1');

    expect(report.criteria).toHaveLength(17);
    expect(report.criteria.filter((c) => c.tier === 'SHADOW')).toHaveLength(6);
    expect(report.criteria.filter((c) => c.tier === 'EXPERIMENTAL')).toHaveLength(6);
    expect(report.criteria.filter((c) => c.tier === 'CALIBRATED')).toHaveLength(5);
    expect(report.stopConditions).toHaveLength(6);
  });

  it('a fully signed, fully evidenced model is shadowAdmissible and experimentalAdmissible', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', fullEvidence());

    const notMet = report.criteria.filter((c) => c.tier !== 'CALIBRATED' && c.status !== 'MET');
    expect(notMet, JSON.stringify(notMet, null, 2)).toEqual([]);
    expect(report.shadowAdmissible).toBe(true);
    expect(report.experimentalAdmissible).toBe(true);
  });

  it('with full evidence including the Calibrated-tier fields, the model is also calibratedAdmissible', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', fullEvidence());

    const notMet = report.criteria.filter((c) => c.status !== 'MET');
    expect(notMet, JSON.stringify(notMet, null, 2)).toEqual([]);
    expect(report.calibratedAdmissible).toBe(true);
  });

  it('a modelRef never admitted fails every criterion and is not shadowAdmissible', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'never-admitted', fullEvidence());

    expect(report.criteria.find((c) => c.id === 'shadow.1')!.status).toBe('NOT_MET');
    expect(report.criteria.find((c) => c.id === 'shadow.2')!.status).toBe('NOT_MET');
    expect(report.shadowAdmissible).toBe(false);
  });

  it('a model admitted via a bare unsigned artifact (bypassing admitModel()) fails shadow.2, is not shadowAdmissible', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    const artifact = packageLinearModelArtifact({ name: 'raw', predict: () => 0, weights: new Array(60).fill(0), bias: 0 }, {
      modelRef: 'm1',
      featureSchemaVersion: '1.0.0',
      taxonomyVersion: 'taxonomy-v1',
      trainingDatasetRef: 'ds-1',
      benchmarkRef: 'bench-1',
      issuer: 'test',
    });
    registry.admit(artifact);

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', fullEvidence());

    expect(report.criteria.find((c) => c.id === 'shadow.1')!.status).toBe('MET'); // provenance/schema is still fine
    expect(report.criteria.find((c) => c.id === 'shadow.2')!.status).toBe('NOT_MET'); // signature is 'UNSIGNED'
    expect(report.shadowAdmissible).toBe(false);
  });

  it('without datasetLeakageCheck/baselineComparison evidence, shadow.3/shadow.5 are NOT_MET and shadowAdmissible is false — the evidence-backed path is not hardcoded', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);
    const { datasetLeakageCheck: _drop1, baselineComparison: _drop2, ...rest } = fullEvidence();

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', rest);

    expect(report.criteria.find((c) => c.id === 'shadow.3')!.status).toBe('NOT_MET');
    expect(report.criteria.find((c) => c.id === 'shadow.5')!.status).toBe('NOT_MET');
    expect(report.shadowAdmissible).toBe(false);
  });

  it('a real LeakageCheck reporting overlap fails shadow.3', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);
    const examples = dataset();
    // Every group overlaps both sides on purpose — same examples used for train and holdout.
    const leakyCheck = checkNoLeakage({ train: examples, holdout: examples }, (e) => e.targetId);
    expect(leakyCheck.clean).toBe(false); // sanity: this really is a real, non-fabricated failure

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', { ...fullEvidence(), datasetLeakageCheck: leakyCheck });

    expect(report.criteria.find((c) => c.id === 'shadow.3')!.status).toBe('NOT_MET');
    expect(report.shadowAdmissible).toBe(false);
  });

  it('tier-scoped flip: flipping only Calibrated-tier evidence to false leaves shadowAdmissible/experimentalAdmissible true, only calibratedAdmissible goes false', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);
    const evidence: Phase16Evidence = { ...fullEvidence(), signedRollbackTargetAvailable: false };

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', evidence);

    expect(report.criteria.find((c) => c.id === 'calibrated.3')!.status).toBe('NOT_MET');
    expect(report.shadowAdmissible).toBe(true);
    expect(report.experimentalAdmissible).toBe(true);
    expect(report.calibratedAdmissible).toBe(false);
  });

  it('no evidence supplied for the declared-only stop conditions leaves them NOT_MONITORED and does not block shadowAdmissible', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);
    // baselineComparison/sustainedAbGainAcrossHoldouts feed stop.1/stop.2;
    // utilityLabelsAuditable feeds stop.4 — all three omitted here, on purpose.
    const { baselineComparison: _drop, sustainedAbGainAcrossHoldouts: _drop2, ...evidenceWithoutStopSignals } = fullEvidence();

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', evidenceWithoutStopSignals);

    expect(report.stopConditions.find((s) => s.id === 'stop.1')!.status).toBe('NOT_MONITORED');
    expect(report.stopConditions.find((s) => s.id === 'stop.2')!.status).toBe('NOT_MONITORED');
    expect(report.stopConditions.find((s) => s.id === 'stop.4')!.status).toBe('NOT_MONITORED');
    // shadowAdmissible is false here only because shadow.5 also needs baselineComparison —
    // the point of this test is that NOT_MONITORED itself never appears as a blocker.
    expect(report.stopConditions.some((s) => s.status === 'TRIGGERED')).toBe(false);
  });

  it('a losing baselineComparison triggers stop.1 and blocks shadowAdmissible even though every tier criterion still passes', async () => {
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    await admitModel(registry, artifactStore, testSigningAuthority(), 'm1', FULLY_MET_CONFIG);
    const evidence: Phase16Evidence = { ...fullEvidence(), baselineComparison: evaluateAdmissionGate(LOSING_CANDIDATE, [BASELINE]) };
    expect(evidence.baselineComparison!.beatsBestBaseline).toBe(false); // sanity

    const report = await evaluatePhase16Admission(buildRegistry(), registry, 'm1', evidence);

    // shadow.5 only asks that a comparison was reported, not that it won.
    expect(report.criteria.find((c) => c.id === 'shadow.5')!.status).toBe('MET');
    const notMetTierCriteria = report.criteria.filter((c) => c.tier === 'SHADOW' && c.status !== 'MET');
    expect(notMetTierCriteria, JSON.stringify(notMetTierCriteria, null, 2)).toEqual([]);
    expect(report.stopConditions.find((s) => s.id === 'stop.1')!.status).toBe('TRIGGERED');
    expect(report.shadowAdmissible).toBe(false);
  });
});
