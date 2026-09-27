import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CampaignEventStore } from '../events/store.js';
import { ExecutionAttemptStore } from '../execution/execution-attempt-store.js';
import type { RunStepStore } from '../runsteps/store.js';
import { ModelPromotionRegistry } from '../promotion/registry.js';
import { authorityFor, type PromotionState } from '../promotion/types.js';
import { CampaignWorldMaterializer } from '../world/materializer.js';
import { worldPositionOf } from '../world/binding.js';
import { buildHistoryView, buildSettledAttemptsByReason } from '../features/history-view.js';
import { compileCandidateFeatures, CANDIDATE_COMPILER_BUILD, CANDIDATE_TAXONOMY_VERSION } from '../features/candidate-compiler.js';
import { FEATURE_SCHEMA_VERSION } from '../features/coordinates.js';
import { enumerateEligibleCandidates, DEFAULT_ELIGIBILITY_POLICY, type EligibilityPolicy } from '../candidates/enumerate.js';
import type { ProbeCatalogEntry } from '../candidates/catalog.js';
import { rankCandidates, type RankedCandidate } from '../shadow/rank.js';
import { heuristicBaseline } from '../training/baselines/heuristic-baseline.js';
import { loadFittedLinearModel } from '../training/baselines/linear-regression-baseline.js';
import type { RecommendationBinding } from '../domain/recommendation-binding.js';
import { mixCandidates, type BindingContext, type MixResult } from './mixer.js';
import { validatePolicy, type PlannerPolicy } from './policy.js';
import { dispatchDecisions, type DispatchedStep } from './dispatch.js';
import type { FrozenSignal } from '../shadow/signal.js';
import { AssessmentRunStore, type IntelligenceStatus } from './assessment-run-store.js';

/**
 * §15's own admission checklist never named this gap, but `promotion/types.ts`'s
 * own doc comment did: "the model cannot promote itself" only means something if
 * something *reads* `authorityFor()` before honoring a model's ranking. Until this
 * file existed, nothing did — `mixer.ts`/`dispatch.ts` compose a batch and dispatch
 * it regardless of what state (if any) the model named in a `PlannerRunConfig` is
 * actually in. This is the single call site that closes that gap: `modelState` is
 * read from the same `ModelPromotionRegistry` row `ab.ts`'s promotion events
 * write to — not from `PlannerRunConfig`, which cannot be trusted to say "OFF"
 * about itself — and `authorityFor(modelState)` decides, before any ranking or
 * dispatch happens, whether the configured model gets to run at all
 * (`rankAndLogCandidates`), whether its ranking may reach `dispatchDecisions()`
 * (`influencesRunStepCreation`), and whether its configured `modelShareCap` is
 * honored as a real bound or lifted (`boundedShare`).
 */
export interface PlannerModelConfig {
  readonly modelRef: string;
  /** `training/model-artifact.ts`'s `SerializedWeights` shape, minus `kind` — this file only knows how to load a linear-regression model; a caller that configures a different `kind` fails config validation before reaching here (see `planner/cli.ts`). */
  readonly weights: { readonly weights: readonly number[]; readonly bias: number };
}

export interface PlannerRunConfig {
  readonly catalog: readonly ProbeCatalogEntry[];
  readonly policy: PlannerPolicy;
  readonly eligibility?: EligibilityPolicy;
  /** Omitted entirely means no model arm at all — mandatory/heuristic/exploration only, same batch mixer.ts already produces for any pre-Phase-5 caller. */
  readonly model?: PlannerModelConfig;
}

export interface PlannerRunContext {
  readonly campaignId: string;
  readonly targetId: string;
  readonly assessmentRunId: string;
}

export interface PlannerRunDeps {
  readonly db: DatabaseSync;
  readonly events: CampaignEventStore;
  readonly runSteps: RunStepStore;
  /** Optional for tests that have no execution history to seed — defaults to a real store over the same `db`. */
  readonly attempts?: ExecutionAttemptStore;
  readonly registry?: ModelPromotionRegistry;
  readonly materializer?: CampaignWorldMaterializer;
  /** грань №20. Defaults to a real store over the same db, same as registry/materializer/attempts above — safe to default-construct since its write methods are tolerant no-ops against a row that doesn't exist; only start() ever creates one, and this file never calls start() (see assessment-run-store.ts's own doc comment for why that's a delivery-surface concern, not this file's). */
  readonly assessmentRuns?: AssessmentRunStore;
  /** Injectable for deterministic tests. Defaults to `Math.random` — real exploration-arm randomness for a real run. */
  readonly rng?: () => number;
}

export interface PlannerRunReport {
  readonly mix: MixResult;
  readonly dispatched: DispatchedStep[];
  readonly modelState: PromotionState;
  /** 0 when no model is configured, or when authorityFor(modelState).rankAndLogCandidates is false — those cases never call rankCandidates() at all. */
  readonly modelRankedCount: number;
  /** True iff the model's ranking was passed into mixCandidates() — i.e. authorityFor(modelState).influencesRunStepCreation. False for OFF and SHADOW, matching Phase 3's own "ranks and logs, RunStepStore never moves" behavior. */
  readonly modelInfluencedDispatch: boolean;
  /** Non-null iff a model was configured but not ranked — either authorityFor() denied it (never admitted, or OFF), or its registry-recorded featureSchemaVersion/taxonomyVersion doesn't match the compiler's current values. Null whenever ranking actually happened, or no model was configured at all. */
  readonly modelSkipReason: string | null;
  /** грань №20: this call's own intelligence_status — HEALTHY unless the model arm's rankCandidates() call fell back to the heuristic baseline (ranking.usedFallback). Computed fresh every call, never accumulated — see assessment-run-store.ts's own doc comment for why. */
  readonly intelligenceStatus: IntelligenceStatus;
  /** False iff AssessmentRunStore.start() was never called for ctx.assessmentRunId — intelligenceStatus above was computed but has no durable row to land in. Never blocks anything either way. */
  readonly intelligenceStatusRecorded: boolean;
}

const NO_MODEL_DIGEST = 'no-model-configured';

function digestOfWeights(weights: PlannerModelConfig['weights']): string {
  return createHash('sha256').update(JSON.stringify({ kind: 'linear-regression', weights: weights.weights, bias: weights.bias })).digest('hex');
}

/** authorityFor()'s OFF case never ranks, so this is only ever called for the three states FrozenSignal.quality actually accepts. */
function qualityFor(state: PromotionState): FrozenSignal['quality'] {
  return state === 'OFF' ? 'SHADOW' : state;
}

/**
 * The planner CLI's actual composition — `enumerateEligibleCandidates()` ->
 * `rankCandidates()` (model, gated by `authorityFor()`; heuristic, always) ->
 * `mixCandidates()` -> `dispatchDecisions()` against a real `CampaignWorldState`
 * from `world/materializer.ts`'s грань №14 snapshot-backed `current()`/`advance()`,
 * not a full `replay()` on every call. Kept separate from `planner/cli.ts` so it
 * can be exercised directly against a real (in-memory) database in tests, the same
 * split `worker/promptfoo-worker.ts` and `worker/cli.ts` already established.
 */
export function runPlannerOnce(deps: PlannerRunDeps, config: PlannerRunConfig, ctx: PlannerRunContext, now = new Date()): PlannerRunReport {
  const runSteps = deps.runSteps;
  const attempts = deps.attempts ?? new ExecutionAttemptStore(deps.db, runSteps);
  const registry = deps.registry ?? new ModelPromotionRegistry(deps.db);
  const materializer = deps.materializer ?? new CampaignWorldMaterializer(deps.db, deps.events);
  const assessmentRuns = deps.assessmentRuns ?? new AssessmentRunStore(deps.db);
  const rng = deps.rng ?? Math.random;
  const eligibilityPolicy = config.eligibility ?? DEFAULT_ELIGIBILITY_POLICY;

  const { world } = materializer.advance(ctx.campaignId, now);
  const position = worldPositionOf(world);

  const allEvents = deps.events.listByCampaign(ctx.campaignId);
  const settledAttemptsByReason = buildSettledAttemptsByReason(attempts.listByCampaign(ctx.campaignId), runSteps);
  const historyView = buildHistoryView(allEvents, ctx.campaignId, allEvents.length, settledAttemptsByReason);

  const { eligible } = enumerateEligibleCandidates(config.catalog, ctx.targetId, historyView, eligibilityPolicy);
  const features = eligible.map((c) => compileCandidateFeatures({ targetId: c.targetId, probe: { probeId: c.probeId }, budget: { targetCallsUsed: 0, targetCallsBudget: 0 } }, historyView));

  const modelRecord = config.model ? registry.get(config.model.modelRef) : null;
  const modelState: PromotionState = modelRecord?.state ?? 'OFF';
  const authority = authorityFor(modelState);
  const planningQuality = qualityFor(modelState);

  const heuristicRanking = rankCandidates(heuristicBaseline.fit([]), 'heuristic', features, position, planningQuality);

  let modelRanked: RankedCandidate[] = [];
  let modelRankedCount = 0;
  let modelInfluencedDispatch = false;
  let modelSkipReason: string | null = null;
  let intelligenceStatus: IntelligenceStatus = 'HEALTHY';
  let effectivePolicy = config.policy;
  const modelDigest = config.model ? digestOfWeights(config.model.weights) : NO_MODEL_DIGEST;

  if (config.model && modelRecord && authority.rankAndLogCandidates) {
    const registeredSchema = modelRecord.artifact.featureSchemaVersion;
    const registeredTaxonomy = modelRecord.artifact.taxonomyVersion;
    const schemaMismatch = registeredSchema !== FEATURE_SCHEMA_VERSION;
    const taxonomyMismatch = registeredTaxonomy !== CANDIDATE_TAXONOMY_VERSION;
    if (schemaMismatch || taxonomyMismatch) {
      // A model's SignedModelArtifact records both the featureSchemaVersion and the
      // taxonomyVersion it was trained under (training/model-artifact.ts). Neither
      // mismatch is something dot(weights, x) can notice on its own — a stale model
      // would otherwise score every candidate against the wrong coordinates (schema)
      // or against probe/vulnerability-class buckets that no longer mean what they
      // meant at training time (taxonomy), and never error, just be silently wrong.
      // Refusing here treats either mismatch the same as authorityFor() denying the
      // model outright: ranked=0, never reaches dispatch.
      const reasons: string[] = [];
      if (schemaMismatch) reasons.push(`featureSchemaVersion (registered ${registeredSchema}, compiler is ${FEATURE_SCHEMA_VERSION})`);
      if (taxonomyMismatch) reasons.push(`taxonomyVersion (registered ${registeredTaxonomy}, compiler is ${CANDIDATE_TAXONOMY_VERSION})`);
      modelSkipReason = `model ${config.model.modelRef} refused: ${reasons.join(' and ')} — refusing to rank with weights trained under a different compiler configuration`;
    } else {
      const fittedModel = loadFittedLinearModel(config.model.weights);
      const ranking = rankCandidates(fittedModel, config.model.modelRef, features, position, planningQuality);
      modelRankedCount = ranking.ranked.length;
      // грань №20: DEGRADED describes the configured model's own health, not
      // whether its output reached dispatch — captured regardless of
      // authority.influencesRunStepCreation below.
      if (ranking.usedFallback) intelligenceStatus = 'DEGRADED';

      if (authority.influencesRunStepCreation) {
        modelRanked = ranking.ranked;
        modelInfluencedDispatch = true;
        if (!authority.boundedShare) {
          // CALIBRATED: policy.ts's own doc comment on modelShareCap says this cap is
          // "EXPERIMENTAL-only" and CALIBRATED removes it — 1 - explorationShare is
          // the maximum validatePolicy() itself will ever accept for this policy's
          // explorationShare, not an arbitrary raise.
          effectivePolicy = { ...config.policy, modelShareCap: Math.max(config.policy.modelShareCap, 1 - config.policy.explorationShare) };
        }
      }
      // SHADOW: ranked above (rankAndLogCandidates), but modelRanked stays empty —
      // Phase 3's own line, redrawn here: a SHADOW model's ranking is produced and
      // could be logged by a caller, but never reaches mixCandidates(), so it can
      // never influence which RunSteps get created.
    }
  } else if (config.model) {
    modelSkipReason = modelRecord
      ? `model ${config.model.modelRef} is ${modelState} — authorityFor().rankAndLogCandidates is false`
      : `model ${config.model.modelRef} was never admitted to the ModelPromotionRegistry — treated as OFF`;
  }
  validatePolicy(effectivePolicy);

  const currentBinding: RecommendationBinding = {
    campaignId: ctx.campaignId,
    targetId: ctx.targetId,
    worldGeneration: position.worldGeneration,
    worldEpoch: position.worldEpoch,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    modelDigest,
    policyVersion: effectivePolicy.policyVersion,
  };
  const bindingContext: BindingContext = {
    campaignId: ctx.campaignId,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    modelDigest,
    policyVersion: effectivePolicy.policyVersion,
    // Every existing mixer.ts caller omits these (mixer.ts's own doc comment: "none
    // of which has a real CampaignWorldState in hand at this call site"). This one
    // does — materializer.advance() just produced it — so a model-arm decision
    // dispatched from here carries a real RecommendationProvenance instead of null.
    world,
    compilerDigest: CANDIDATE_COMPILER_BUILD,
  };

  const mix = mixCandidates(eligible, modelRanked, heuristicRanking.ranked, currentBinding, bindingContext, effectivePolicy, rng, undefined, now);

  const dispatched = dispatchDecisions(deps.db, ctx.assessmentRunId, mix.decisions, effectivePolicy.policyVersion, now, { events: deps.events, campaignId: ctx.campaignId });

  // грань №20: recorded in the same process, right before returning — not a
  // separate step a caller could skip. A safe no-op if AssessmentRunStore.start()
  // was never called for ctx.assessmentRunId (see that method's own doc comment).
  const intelligenceRecord = assessmentRuns.recordIntelligenceStatus(ctx.assessmentRunId, intelligenceStatus, now);

  return {
    mix,
    dispatched,
    modelState,
    modelRankedCount,
    modelInfluencedDispatch,
    modelSkipReason,
    intelligenceStatus,
    intelligenceStatusRecorded: intelligenceRecord.recorded,
  };
}
