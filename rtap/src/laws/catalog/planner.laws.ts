import { mulberry32, randInt, randBool } from '../rng.js';
import { decideExecution, type RecommendationBinding } from '../../domain/recommendation-binding.js';
import { isProvenanceFresh } from '../../domain/recommendation-provenance.js';
import { mixCandidates } from '../../planner/mixer.js';
import type { EligibleCandidate } from '../../candidates/enumerate.js';
import type { RankedCandidate } from '../../shadow/rank.js';
import type { PlannerPolicy } from '../../planner/policy.js';
import { emptyWorld, type CampaignWorldState } from '../../world/state.js';
import { fingerprint } from '../../world/fingerprint.js';
import type { Law } from '../types.js';

/** Mirrors production-profile.laws.ts's own randomWorld() — varies content (entities/epoch/lastSequence), not just generation, since fingerprint() deliberately excludes generation. */
function randomWorld(rng: () => number): CampaignWorldState {
  const base = emptyWorld(`campaign-${randInt(rng, 1, 999)}`, randInt(rng, 0, 5));
  const entityCount = randInt(rng, 0, 4);
  const entities = new Map(base.entities);
  for (let i = 0; i < entityCount; i += 1) {
    const id = `entity-${i}`;
    entities.set(id, { id, type: 'Target' as const, firstSeenSequence: i, lastUpdatedSequence: i });
  }
  return { ...base, epoch: randInt(rng, 0, 50), lastSequence: randInt(rng, -1, 50), entities };
}

const FIXED_BINDING: RecommendationBinding = {
  campaignId: 'campaign-1',
  targetId: 'target-1',
  worldGeneration: 0,
  worldEpoch: 5,
  featureSchemaVersion: '1.0.0',
  modelDigest: 'digest-1',
  policyVersion: 'policy-1',
};

function fakeSignal(worldEpoch: number) {
  return {
    kind: 'PROBE_UTILITY' as const,
    subjectRef: '',
    targetId: FIXED_BINDING.targetId,
    value: 0,
    quality: 'EXPERIMENTAL' as const,
    reasonCodes: [],
    evidenceObservationIds: [],
    modelRef: 'm1',
    adapterRef: null,
    featureSnapshotRef: 'fs-1',
    worldGeneration: 0,
    worldEpoch,
  };
}

function randomMixInputs(seed: number) {
  const rng = mulberry32(seed);
  const mandatoryCount = randInt(rng, 0, 3);
  const nonMandatoryCount = randInt(rng, 5, 40);
  const eligible: EligibleCandidate[] = [
    ...Array.from({ length: mandatoryCount }, (_, i) => ({ targetId: FIXED_BINDING.targetId, probeId: `mandatory-${i}`, mandatory: true })),
    ...Array.from({ length: nonMandatoryCount }, (_, i) => ({ targetId: FIXED_BINDING.targetId, probeId: `probe-${i}`, mandatory: false })),
  ];
  const nonMandatory = eligible.filter((c) => !c.mandatory);
  const modelRanking: RankedCandidate[] = nonMandatory.map((c, i) => ({
    targetId: c.targetId,
    probeId: c.probeId,
    rank: i + 1,
    signal: fakeSignal(FIXED_BINDING.worldEpoch), // fresh — matches currentBinding
  }));
  const heuristicRanking: RankedCandidate[] = [...nonMandatory].reverse().map((c, i) => ({
    targetId: c.targetId,
    probeId: c.probeId,
    rank: i + 1,
    signal: fakeSignal(FIXED_BINDING.worldEpoch),
  }));
  const policy: PlannerPolicy = {
    policyVersion: 'policy-1',
    modelShareCap: 0.3,
    explorationShare: 0.15,
    maxBatchSize: randInt(rng, 1, 20),
  };
  return { eligible, modelRanking, heuristicRanking, policy, rngSeedForMixer: seed + 1000 };
}

function randomBinding(seed: number): RecommendationBinding {
  const rng = mulberry32(seed);
  return {
    campaignId: `campaign-${randInt(rng, 1, 3)}`,
    targetId: `target-${randInt(rng, 1, 3)}`,
    worldGeneration: randInt(rng, 0, 3),
    worldEpoch: randInt(rng, 0, 100),
    featureSchemaVersion: `1.${randInt(rng, 0, 2)}.0`,
    modelDigest: `digest-${randInt(rng, 1, 3)}`,
    policyVersion: `policy-${randInt(rng, 1, 2)}`,
  };
}

// wiki/Arch_Overlay/FROZEN_INTEGRATION.md §10.2, ARCHITECTURE.md §8.
export const plannerLaws: Law[] = [
  {
    id: 'redteam.planner/stale-recommendation-is-not-executed',
    statement:
      'decideExecution() only allows execution when every RecommendationBinding identity field matches exactly and worldEpoch drift is within policy tolerance; a mismatch on any identity field, or an epoch from the future, is always rejected.',
    status: 'implemented',
    trials: 1000,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const recommendation = randomBinding(seed);
      // Half the trials: current == recommendation exactly (must be executable).
      // Half the trials: perturb one field (must be rejected, except epoch within tolerance).
      if (randBool(rng, 0.3)) {
        const decision = decideExecution(recommendation, recommendation);
        if (!decision.executable) {
          return {
            held: false,
            detail: 'Identical binding was rejected as non-executable',
            counterexample: { recommendation },
          };
        }
        return { held: true };
      }

      const current = randomBinding(seed + 1);
      const decision = decideExecution(recommendation, current);
      const identicalIdentity =
        recommendation.campaignId === current.campaignId &&
        recommendation.targetId === current.targetId &&
        recommendation.worldGeneration === current.worldGeneration &&
        recommendation.featureSchemaVersion === current.featureSchemaVersion &&
        recommendation.modelDigest === current.modelDigest &&
        recommendation.policyVersion === current.policyVersion;

      if (!identicalIdentity && decision.executable) {
        return {
          held: false,
          detail: 'A binding with mismatched identity fields was allowed to execute',
          counterexample: { recommendation, current, decision },
        };
      }
      if (identicalIdentity && recommendation.worldEpoch > current.worldEpoch && decision.executable) {
        return {
          held: false,
          detail: 'A recommendation from a future epoch was allowed to execute',
          counterexample: { recommendation, current, decision },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.planner/mandatory-probes-cannot-be-ranked-away',
    statement:
      'mixCandidates() never drops a Probe with mandatory=true from the batch, regardless of where the model/heuristic ranking would have placed it — unless the batch cap itself is smaller than the mandatory count, in which case the shortfall is reported explicitly (mandatoryShortfall), never silently dropped and never silently exceeding the cap.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const { eligible, modelRanking, heuristicRanking, policy, rngSeedForMixer } = randomMixInputs(seed);
      const mandatoryIds = new Set(eligible.filter((c) => c.mandatory).map((c) => c.probeId));
      const result = mixCandidates(eligible, modelRanking, heuristicRanking, FIXED_BINDING, FIXED_BINDING, policy, mulberry32(rngSeedForMixer));

      const includedIds = new Set(result.decisions.map((d) => d.probeId));
      const shortfallIds = new Set(result.mandatoryShortfall.map((s) => s.probeId));
      for (const id of mandatoryIds) {
        const included = includedIds.has(id);
        const reportedAsShortfall = shortfallIds.has(id);
        if (!included && !reportedAsShortfall) {
          return { held: false, detail: `Mandatory probe ${id} vanished — neither included nor reported as shortfall`, counterexample: { id, result } };
        }
        if (included) {
          const decision = result.decisions.find((d) => d.probeId === id);
          if (decision?.arm !== 'mandatory') {
            return { held: false, detail: `Mandatory probe ${id} was included but not via the mandatory arm`, counterexample: decision };
          }
        }
      }
      if (result.decisions.length > policy.maxBatchSize) {
        return { held: false, detail: 'Batch exceeded maxBatchSize while accommodating mandatory probes', counterexample: { size: result.decisions.length, cap: policy.maxBatchSize } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.planner/exploration-arm-never-disappears',
    statement:
      'Whenever any non-mandatory batch budget remains after mandatory probes are seated and there is an eligible non-mandatory candidate to pick, mixCandidates() reserves a non-zero exploration share — never zero purely because the policy or the mixer chose to skip it.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const { eligible, modelRanking, heuristicRanking, policy, rngSeedForMixer } = randomMixInputs(seed);
      const result = mixCandidates(eligible, modelRanking, heuristicRanking, FIXED_BINDING, FIXED_BINDING, policy, mulberry32(rngSeedForMixer));

      const mandatoryCount = eligible.filter((c) => c.mandatory).length;
      const nonMandatoryEligible = eligible.length - mandatoryCount;
      const remainingBudget = policy.maxBatchSize - Math.min(mandatoryCount, policy.maxBatchSize);

      if (remainingBudget > 0 && nonMandatoryEligible > 0 && result.armCounts.exploration === 0) {
        return { held: false, detail: 'Exploration arm was zero despite available budget and eligible candidates', counterexample: { remainingBudget, nonMandatoryEligible, result } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.planner/control-arm-never-disappears',
    statement:
      "Distinct from exploration-arm-never-disappears (ARCHITECTURE.md §8 vs FROZEN_INTEGRATION.md §10.2 name the exploration property independently, both IDs kept as published): this checks the *heuristic/control* arm specifically — whenever the total eligible pool is at least as large as maxBatchSize, mixCandidates() fills the whole batch rather than leaving capacity idle. When eligible supply is genuinely smaller than the cap, a partial batch is correct, not a violation — the first version of this check asserted the opposite and failed on exactly that case (see PR discussion): 6 eligible candidates cannot fill a cap of 13, and that is the mixer behaving correctly, not a missing control arm.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const { eligible, modelRanking, heuristicRanking, policy, rngSeedForMixer } = randomMixInputs(seed);
      const result = mixCandidates(eligible, modelRanking, heuristicRanking, FIXED_BINDING, FIXED_BINDING, policy, mulberry32(rngSeedForMixer));

      if (eligible.length < policy.maxBatchSize) {
        return { held: true }; // not enough supply to fill the cap — a partial batch is correct here
      }

      const unusedCapacity = policy.maxBatchSize - result.decisions.length;
      if (unusedCapacity > 0) {
        return {
          held: false,
          detail: 'mixCandidates left batch capacity unused despite eligible supply >= maxBatchSize',
          counterexample: { eligibleCount: eligible.length, unusedCapacity, result },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.planner/budget-is-never-exceeded',
    statement: 'mixCandidates() never returns more decisions than policy.maxBatchSize, across arbitrary eligible/ranking inputs.',
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const { eligible, modelRanking, heuristicRanking, policy, rngSeedForMixer } = randomMixInputs(seed);
      const result = mixCandidates(eligible, modelRanking, heuristicRanking, FIXED_BINDING, FIXED_BINDING, policy, mulberry32(rngSeedForMixer));
      if (result.decisions.length > policy.maxBatchSize) {
        return { held: false, detail: `Batch size ${result.decisions.length} exceeded cap ${policy.maxBatchSize}`, counterexample: result };
      }
      const uniqueProbeIds = new Set(result.decisions.map((d) => d.probeId));
      if (uniqueProbeIds.size !== result.decisions.length) {
        return { held: false, detail: 'A probeId was dispatched more than once in the same batch', counterexample: result };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.planner/target-scoped-candidates-are-not-merged',
    statement:
      'mixCandidates() treats candidate identity as the (targetId, probeId) pair, never bare probeId: the same probeId eligible for N different Targets in one batch produces N distinct decisions, one per Target — a real bug, found by audit, where a bare-probeId dedup set silently collapsed different Targets\' identical-probeId candidates into one.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const targetCount = randInt(rng, 2, 4);
      const sharedProbeCount = randInt(rng, 3, 8);
      const targets = Array.from({ length: targetCount }, (_, i) => `target-${i}`);

      // Every target gets the exact same set of probeIds — deliberately maximal
      // overlap, so a bare-probeId dedup bug is guaranteed to manifest, not just
      // possible.
      const eligible: EligibleCandidate[] = targets.flatMap((targetId) =>
        Array.from({ length: sharedProbeCount }, (_, i) => ({ targetId, probeId: `shared-${i}`, mandatory: true })),
      );
      const policy: PlannerPolicy = {
        policyVersion: 'policy-1',
        modelShareCap: 0.3,
        explorationShare: 0.15,
        maxBatchSize: eligible.length, // exactly enough room for every (target, probe) pair — mandatory never trims
      };

      const result = mixCandidates(eligible, [], [], FIXED_BINDING, FIXED_BINDING, policy, mulberry32(seed + 2000));

      if (result.decisions.length !== eligible.length) {
        return {
          held: false,
          detail: `expected exactly ${eligible.length} decisions (one per (target, probe) pair), got ${result.decisions.length}`,
          counterexample: { targets, sharedProbeCount, result },
        };
      }
      const decidedKeys = new Set(result.decisions.map((d) => `${d.targetId}:${d.probeId}`));
      if (decidedKeys.size !== eligible.length) {
        return { held: false, detail: 'Some (target, probe) pairs collapsed into the same decision', counterexample: { decidedKeys: [...decidedKeys], result } };
      }
      for (const targetId of targets) {
        const countForTarget = result.decisions.filter((d) => d.targetId === targetId).length;
        if (countForTarget !== sharedProbeCount) {
          return { held: false, detail: `Target ${targetId} got ${countForTarget} decisions, expected ${sharedProbeCount}`, counterexample: result };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.planner/recommendation-provenance-reflects-its-world',
    statement:
      "Audit finding #3's remainder: mixCandidates() attaches RecommendationProvenance to a model-arm decision iff BindingContext supplies both `world` and `compilerDigest` — never fabricated when either is absent, and mandatory/exploration/heuristic decisions never carry one regardless. When present, provenance.worldFingerprint always equals fingerprint() of the exact world instance supplied, provenance.compilerDigest always equals what was supplied, and isProvenanceFresh() agrees exactly with the expiresAt window: fresh strictly before it, never fresh at or after it.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const world = randomWorld(rng);
      const compilerDigest = `compiler-${randInt(rng, 1, 5)}`;
      const supplyContext = randBool(rng, 0.6);

      // eligible is deliberately empty — see mixer.test.ts's own note: this makes
      // the model arm's single slot resolve to modelRanking[0] deterministically,
      // independent of the (still-required, still-positive) explorationShare.
      const modelRanking: RankedCandidate[] = [
        { targetId: FIXED_BINDING.targetId, probeId: 'p0', rank: 1, signal: fakeSignal(FIXED_BINDING.worldEpoch) },
      ];
      const policy: PlannerPolicy = { policyVersion: 'policy-1', modelShareCap: 0.8, explorationShare: 0.2, maxBatchSize: 5 };
      const baseContext = { campaignId: FIXED_BINDING.campaignId, featureSchemaVersion: FIXED_BINDING.featureSchemaVersion, modelDigest: FIXED_BINDING.modelDigest, policyVersion: FIXED_BINDING.policyVersion };
      const bindingContext = supplyContext ? { ...baseContext, world, compilerDigest } : baseContext;
      const now = new Date('2026-08-30T00:00:00.000Z');

      const result = mixCandidates([], modelRanking, [], FIXED_BINDING, bindingContext, policy, mulberry32(seed + 3000), undefined, now);
      const modelDecision = result.decisions.find((d) => d.arm === 'model');
      if (!modelDecision) {
        return { held: false, detail: 'setup: expected exactly one model-arm decision', counterexample: result };
      }

      if (!supplyContext) {
        if (modelDecision.provenance !== null) {
          return { held: false, detail: 'provenance was fabricated despite BindingContext supplying neither world nor compilerDigest', counterexample: modelDecision };
        }
        return { held: true };
      }

      const provenance = modelDecision.provenance;
      if (!provenance) {
        return { held: false, detail: 'provenance was null despite BindingContext supplying both world and compilerDigest', counterexample: modelDecision };
      }
      if (provenance.worldFingerprint !== fingerprint(world)) {
        return { held: false, detail: 'worldFingerprint did not match fingerprint() of the exact world supplied', counterexample: { provenance, expected: fingerprint(world) } };
      }
      if (provenance.compilerDigest !== compilerDigest) {
        return { held: false, detail: 'compilerDigest did not match what BindingContext supplied', counterexample: { provenance, compilerDigest } };
      }
      if (!isProvenanceFresh(provenance, now)) {
        return { held: false, detail: 'a freshly built provenance record was not reported fresh at its own createdAt', counterexample: provenance };
      }
      const atExpiry = new Date(provenance.expiresAt);
      if (isProvenanceFresh(provenance, atExpiry)) {
        return { held: false, detail: 'provenance was still reported fresh exactly at its own expiresAt', counterexample: provenance };
      }
      return { held: true };
    },
  },
];
