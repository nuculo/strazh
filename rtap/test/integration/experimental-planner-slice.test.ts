import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ModelPromotionRegistry } from '../../src/promotion/registry.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { exportDataset } from '../../src/training/dataset-exporter.js';
import { makeLinearRegressionBaseline } from '../../src/training/baselines/linear-regression-baseline.js';
import { heuristicBaseline } from '../../src/training/baselines/heuristic-baseline.js';
import { packageLinearModelArtifact } from '../../src/training/model-artifact.js';
import { enumerateEligibleCandidates } from '../../src/candidates/enumerate.js';
import { compileCandidateFeatures } from '../../src/features/candidate-compiler.js';
import { buildHistoryView, targetProbeKey } from '../../src/features/history-view.js';
import { rankCandidates } from '../../src/shadow/rank.js';
import { replay } from '../../src/world/replay.js';
import { worldPositionOf } from '../../src/world/binding.js';
import { mixCandidates } from '../../src/planner/mixer.js';
import { DEFAULT_EXPERIMENTAL_POLICY } from '../../src/planner/policy.js';
import { dispatchDecisions, listDispatchLog } from '../../src/planner/dispatch.js';
import { joinDispatchWithOutcomes, computeArmPerformance, evaluateABGate } from '../../src/planner/ab.js';
import type { ProbeCatalogEntry } from '../../src/candidates/catalog.js';
import type { RecommendationBinding } from '../../src/domain/recommendation-binding.js';
import { buildSyntheticCorpus, allEventsAcrossCampaigns } from '../training/fixtures.js';
import { signAndGate } from '../promotion/signing-fixture.js';

/**
 * Phase 5 vertical slice: an EXPERIMENTAL-promoted model's ranking is mixed with
 * mandatory/heuristic/exploration arms under a real world binding (Phase 4), and —
 * the behavioral line this phase draws relative to Phase 3 — the mixed batch is
 * actually dispatched to durable RunSteps. Then simulated outcomes feed the A/B
 * gate that decides whether the model earns CALIBRATED or gets demoted back to
 * SHADOW.
 */
describe('Phase 5 vertical slice: EXPERIMENTAL mixing -> real RunStep dispatch -> A/B promotion decision', () => {
  it('dispatches a mixed batch to durable RunSteps — unlike SHADOW, EXPERIMENTAL actually creates them', async () => {
    const corpus = buildSyntheticCorpus({ campaigns: 1, targetsPerCampaign: 1, probesPerTarget: 10, seed: 91 });
    const allEvents = allEventsAcrossCampaigns(corpus.eventStore, ['campaign-0']);
    const { examples } = exportDataset(corpus.records, allEvents);
    const fittedModel = makeLinearRegressionBaseline({ epochs: 200 }).fit(examples);

    const db = openInMemoryDatabase();
    const registry = new ModelPromotionRegistry(db);
    const artifact = packageLinearModelArtifact(fittedModel, {
      modelRef: 'phase5-linear-v1',
      featureSchemaVersion: examples[0]!.features.featureSchemaVersion,
      taxonomyVersion: examples[0]!.features.taxonomyVersion,
      trainingDatasetRef: 'synthetic-seed-91',
      benchmarkRef: 'phase5-slice',
      issuer: 'rtap-phase5',
    });
    const { signed, gate: signatureGate } = await signAndGate(artifact);
    registry.admit(signed);
    registry.applyEvent('phase5-linear-v1', 'MODEL_ADMITTED', signatureGate); // OFF -> SHADOW
    const promoted = registry.applyEvent('phase5-linear-v1', 'OFFLINE_AND_SHADOW_GATES_PASSED'); // SHADOW -> EXPERIMENTAL
    expect(promoted.to).toBe('EXPERIMENTAL');

    const { world } = replay(allEvents, 'campaign-0');
    const position = worldPositionOf(world);

    const catalog: ProbeCatalogEntry[] = [
      { probeId: 'mandatory-coverage:default', mandatory: true },
      ...[...new Set(examples.map((e) => e.probeId))].map((probeId) => ({ probeId, mandatory: false })),
    ];
    const targetId = 'campaign-0-target-0';
    const historyView = buildHistoryView(allEvents, 'campaign-0', allEvents.length);

    // The catalog here is drawn from the same historical corpus used for training
    // (exportDataset), so under the *default* eligibility policy (max 1 attempt)
    // every non-mandatory probe would already be exhausted — realistic Planner
    // usage draws its catalog from the platform's full probe taxonomy, not from
    // already-consumed training data. A permissive policy stands in for that here
    // so the mixing/dispatch mechanism under test actually has candidates to work
    // with, rather than re-testing eligibility policy edge cases (covered in
    // test/candidates/enumerate.test.ts already).
    const { eligible } = enumerateEligibleCandidates(catalog, targetId, historyView, { maxAttemptsPerProbe: 5, excludeConfirmedVulnerable: false });
    const features = eligible.map((c) =>
      compileCandidateFeatures({ targetId, probe: { probeId: c.probeId }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, historyView),
    );

    const modelRanking = rankCandidates(fittedModel, artifact.modelRef, features, position, 'EXPERIMENTAL');
    const heuristicRanking = rankCandidates(heuristicBaseline.fit([]), 'heuristic', features, position, 'EXPERIMENTAL');

    const currentBinding: RecommendationBinding = {
      campaignId: 'campaign-0',
      targetId,
      worldGeneration: position.worldGeneration,
      worldEpoch: position.worldEpoch,
      featureSchemaVersion: artifact.featureSchemaVersion,
      modelDigest: artifact.sha256,
      policyVersion: DEFAULT_EXPERIMENTAL_POLICY.policyVersion,
    };
    const bindingContext = {
      campaignId: 'campaign-0',
      featureSchemaVersion: artifact.featureSchemaVersion,
      modelDigest: artifact.sha256,
      policyVersion: DEFAULT_EXPERIMENTAL_POLICY.policyVersion,
    };

    const mixed = mixCandidates(
      eligible,
      modelRanking.ranked,
      heuristicRanking.ranked,
      currentBinding,
      bindingContext,
      DEFAULT_EXPERIMENTAL_POLICY,
      () => 0.42,
    );

    expect(mixed.decisions.some((d) => d.probeId === 'mandatory-coverage:default' && d.arm === 'mandatory')).toBe(true);
    expect(mixed.armCounts.exploration).toBeGreaterThan(0);
    expect(mixed.staleModelRecommendationsDropped).toBe(0); // binding was built from the same world position, nothing should be stale

    const runSteps = new RunStepStore(db);
    const before = runSteps.listByAssessmentRun('run-1').length;
    const dispatched = dispatchDecisions(db, 'run-1', mixed.decisions, DEFAULT_EXPERIMENTAL_POLICY.policyVersion);
    const after = runSteps.listByAssessmentRun('run-1').length;

    // This is the whole point of EXPERIMENTAL vs SHADOW: RunStepStore actually moved.
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(mixed.decisions.length);
    expect(dispatched.every((d) => !d.deduped)).toBe(true);
  });

  it('an A/B gate with sufficient favorable samples recommends PROMOTE, feeding a real EXPERIMENTAL -> CALIBRATED transition', async () => {
    const db = openInMemoryDatabase();
    const registry = new ModelPromotionRegistry(db);
    const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
    const artifact = packageLinearModelArtifact(model, {
      modelRef: 'ab-model-1',
      featureSchemaVersion: '1.0.0',
      taxonomyVersion: 'taxonomy-v1',
      trainingDatasetRef: 'ds',
      benchmarkRef: 'bench',
      issuer: 'test',
    });
    const { signed, gate: signatureGate } = await signAndGate(artifact);
    registry.admit(signed);
    registry.applyEvent('ab-model-1', 'MODEL_ADMITTED', signatureGate);
    registry.applyEvent('ab-model-1', 'OFFLINE_AND_SHADOW_GATES_PASSED');
    expect(registry.get('ab-model-1')?.state).toBe('EXPERIMENTAL');

    const dispatchLog = [
      ...Array.from({ length: 25 }, (_, i) => ({ assessmentRunId: 'run-1', runStepId: `s${i}`, targetId: 't1', probeId: `model-${i}`, arm: 'model' as const, policyVersion: 'p1', dispatchedAt: '' })),
      ...Array.from({ length: 25 }, (_, i) => ({ assessmentRunId: 'run-1', runStepId: `s${i}`, targetId: 't1', probeId: `heur-${i}`, arm: 'heuristic' as const, policyVersion: 'p1', dispatchedAt: '' })),
    ];
    const outcomes = new Map<string, number>([
      ...Array.from({ length: 25 }, (_, i) => [targetProbeKey('t1', `model-${i}`), 0.8] as const),
      ...Array.from({ length: 25 }, (_, i) => [targetProbeKey('t1', `heur-${i}`), 0.5] as const),
    ]);

    const joined = joinDispatchWithOutcomes(dispatchLog, outcomes);
    const performance = computeArmPerformance(joined);
    const gate = evaluateABGate(performance);

    expect(gate.sufficientSample).toBe(true);
    expect(gate.recommendation).toBe('PROMOTE');

    const promotionEvent = gate.recommendation === 'PROMOTE' ? 'AB_GATES_PASSED' : gate.recommendation === 'DEMOTE' ? 'SAFETY_OR_COVERAGE_REGRESSION' : null;
    expect(promotionEvent).toBe('AB_GATES_PASSED');
    // грань №18: AB_GATES_PASSED is now signature-gated too — same artifact, same gate.
    const transition = registry.applyEvent('ab-model-1', promotionEvent!, signatureGate);
    expect(transition.to).toBe('CALIBRATED');
  });

  it('an A/B gate showing regression demotes EXPERIMENTAL back to SHADOW, not to OFF', async () => {
    const db = openInMemoryDatabase();
    const registry = new ModelPromotionRegistry(db);
    const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
    const artifact = packageLinearModelArtifact(model, {
      modelRef: 'ab-model-2',
      featureSchemaVersion: '1.0.0',
      taxonomyVersion: 'taxonomy-v1',
      trainingDatasetRef: 'ds',
      benchmarkRef: 'bench',
      issuer: 'test',
    });
    const { signed, gate: signatureGate } = await signAndGate(artifact);
    registry.admit(signed);
    registry.applyEvent('ab-model-2', 'MODEL_ADMITTED', signatureGate);
    registry.applyEvent('ab-model-2', 'OFFLINE_AND_SHADOW_GATES_PASSED');

    const performance = [
      { arm: 'model' as const, n: 30, meanLabel: 0.2 },
      { arm: 'heuristic' as const, n: 30, meanLabel: 0.6 },
    ];
    const gate = evaluateABGate(performance);
    expect(gate.recommendation).toBe('DEMOTE');

    const transition = registry.applyEvent('ab-model-2', 'SAFETY_OR_COVERAGE_REGRESSION');
    expect(transition.to).toBe('SHADOW');
  });
});
