import type { LawRegistry } from '../laws/registry.js';
import type { ModelPromotionRegistry } from './registry.js';
import { FEATURE_SCHEMA_VERSION } from '../features/coordinates.js';
import { DEFAULT_UTILITY_POLICY } from '../training/utility-label-policy.js';
import type { LeakageCheck } from '../training/splits.js';
import type { AdmissionGateResult } from '../training/admission-gate.js';

/**
 * ADAPTIVE_REDTEAM_RUNTIME.md §16 "Admission criteria" — a per-model promotion
 * readiness report, distinct from `execution/admission.ts`'s `evaluatePhase5Admission()`
 * (that one covers EXECUTION_SAFETY_RECOVERY.md §15, a platform-wide precondition
 * check with no model involved). This §16 is also unrelated to "грань №16" (the
 * signing facet) — an unfortunate but real numbering collision, not the same thing.
 *
 * Same honest-by-construction discipline `admission.ts` established: nothing is
 * MET without a real law, a real computed result, or an explicit caller-supplied
 * fact — never inflated. Unlike `admission.ts`, this is per-model (§16's own
 * criteria — "signed model artifact," "positive lift" — are inherently about one
 * candidate's evidence, not the platform), and the three tiers are ADDITIVE
 * (Shadow requirements always apply; Experimental adds six more; Calibrated adds
 * five more) — a model can legitimately be Shadow-admissible without being
 * Experimental-admissible, so this report exposes each tier's admissibility
 * separately rather than one flat boolean.
 *
 * This is deliberately a report, not a gate: like `evaluatePhase5Admission()`, it
 * has no CLI wrapper and nothing in this repo automatically blocks a `promote`
 * call on its output — `promotion/types.ts`'s own doc comment already draws that
 * line ("the model cannot promote itself... belongs to RTAP policy"). An operator
 * reads this report and decides.
 */
export type AdmissionTier = 'SHADOW' | 'EXPERIMENTAL' | 'CALIBRATED';
export type CriterionStatus = 'MET' | 'NOT_MET';

/**
 * Stop conditions get a THIRD status admission.ts's binary MET/NOT_MET never
 * needed. A stop condition with no mechanism to check it must not silently read as
 * "not triggered" (false optimism — hides a real failure mode) nor as "triggered"
 * (false pessimism — blocks every model forever until every mechanism exists,
 * defeating the point of a graduated gate). Only TRIGGERED blocks admissibility;
 * NOT_MONITORED is disclosed but never blocks — this codebase's gates block on
 * positive evidence of a problem, never on absence of monitoring.
 */
export type StopConditionStatus = 'CLEAR' | 'TRIGGERED' | 'NOT_MONITORED';

export interface AdmissionCriterion {
  readonly id: string;
  readonly tier: AdmissionTier;
  readonly statement: string;
  readonly status: CriterionStatus;
  readonly detail: string;
}

export interface StopCondition {
  readonly id: string;
  readonly statement: string;
  readonly status: StopConditionStatus;
  readonly detail: string;
}

export interface Phase16AdmissionReport {
  readonly modelRef: string;
  readonly criteria: readonly AdmissionCriterion[];
  readonly stopConditions: readonly StopCondition[];
  readonly shadowAdmissible: boolean;
  readonly experimentalAdmissible: boolean;
  readonly calibratedAdmissible: boolean;
}

/**
 * Three evidence tiers, not `admission.ts`'s two. Several §16 criteria are backed
 * by real, already-tested pure functions that need actual per-model data as
 * arguments (`training/splits.ts`'s `checkNoLeakage()`, `training/admission-gate.ts`'s
 * `evaluateAdmissionGate()`) — not a law (`LawRegistry.runAll()` can't invoke a
 * function that needs a real split/evaluation handed to it, not a seed), and
 * discarding a real computed result down to a bare declared boolean would be
 * dishonest in the other direction. So `datasetLeakageCheck`/`baselineComparison`
 * carry the REAL result objects; every other field here is a genuine gap — nothing
 * in this repo computes it yet, named individually in `evaluatePhase16Admission()`'s
 * own detail strings, not just "false".
 */
export interface Phase16Evidence {
  readonly datasetLeakageCheck?: LeakageCheck;
  readonly baselineComparison?: AdmissionGateResult;
  readonly utilityLabelOwnershipDocumented?: boolean;
  readonly uniqueFindingsLiftPer100Calls?: number;
  readonly mandatoryTaxonomyCoverageRegressed?: boolean;
  readonly errorAndTimeoutRatesWithinBounds?: boolean;
  readonly sustainedAbGainAcrossHoldouts?: boolean;
  readonly modelAndFeatureDriftWithinThresholds?: boolean;
  readonly signedRollbackTargetAvailable?: boolean;
  readonly unifiedReasonCodesAvailable?: boolean;
  readonly criticalClassRegressionWithinPolicy?: boolean;
  readonly utilityLabelsAuditable?: boolean;
}

function directCriterion(id: string, tier: AdmissionTier, statement: string, met: boolean, detail: string): AdmissionCriterion {
  return { id, tier, statement, status: met ? 'MET' : 'NOT_MET', detail };
}

function lawCriterion(id: string, tier: AdmissionTier, statement: string, lawId: string, held: (lawId: string) => boolean, detail?: string): AdmissionCriterion {
  const met = held(lawId);
  return { id, tier, statement, status: met ? 'MET' : 'NOT_MET', detail: detail ?? `${met ? 'held' : 'did not hold or is not implemented'}: ${lawId}` };
}

function evidenceCriterion<T>(
  id: string,
  tier: AdmissionTier,
  statement: string,
  evidence: T | undefined,
  predicate: (e: T) => boolean,
  detail: (e: T | undefined) => string,
): AdmissionCriterion {
  const met = evidence !== undefined && predicate(evidence);
  return { id, tier, statement, status: met ? 'MET' : 'NOT_MET', detail: detail(evidence) };
}

function declaredCriterion(id: string, tier: AdmissionTier, statement: string, value: boolean | undefined, gapDetail: string): AdmissionCriterion {
  return { id, tier, statement, status: value === true ? 'MET' : 'NOT_MET', detail: value === true ? 'declared true by caller' : gapDetail };
}

function lawStopCondition(id: string, statement: string, lawId: string | readonly string[], held: (lawId: string) => boolean, clearDetail: string, triggeredDetail: string): StopCondition {
  const lawIds = Array.isArray(lawId) ? lawId : [lawId];
  const clear = lawIds.every((l) => held(l));
  return { id, statement, status: clear ? 'CLEAR' : 'TRIGGERED', detail: clear ? clearDetail : triggeredDetail };
}

function declaredStopCondition(id: string, statement: string, value: boolean | undefined, clearDetail: string, triggeredDetail: string, unmonitoredDetail: string): StopCondition {
  if (value === undefined) return { id, statement, status: 'NOT_MONITORED', detail: unmonitoredDetail };
  return { id, statement, status: value ? 'CLEAR' : 'TRIGGERED', detail: value ? clearDetail : triggeredDetail };
}

export async function evaluatePhase16Admission(
  registry: LawRegistry,
  promotionRegistry: ModelPromotionRegistry,
  modelRef: string,
  evidence: Phase16Evidence = {},
  seed = 1,
): Promise<Phase16AdmissionReport> {
  const report = await registry.runAll(seed);
  const held = (lawId: string): boolean => report.results.some((r) => r.id === lawId && r.status === 'implemented' && r.held);

  const record = promotionRegistry.get(modelRef);
  const featureSchemaCurrent = record !== null && record.artifact.featureSchemaVersion === FEATURE_SCHEMA_VERSION;
  const provenanceComplete = record !== null && featureSchemaCurrent;
  const isSigned = record !== null && record.artifact.signature !== 'UNSIGNED' && record.artifact.weightsRef !== null;

  const notAdmittedDetail = `${modelRef} has not been admitted to the ModelPromotionRegistry.`;

  const criteria: AdmissionCriterion[] = [
    directCriterion(
      'shadow.1',
      'SHADOW',
      'Complete provenance and immutable FeatureSchema.',
      provenanceComplete,
      record === null
        ? notAdmittedDetail
        : featureSchemaCurrent
          ? `${modelRef} is admitted with the provenance fields rtap:model-snapshot requires, and its featureSchemaVersion (${record.artifact.featureSchemaVersion}) matches the compiler's current FEATURE_SCHEMA_VERSION.`
          : `${modelRef}'s registered featureSchemaVersion (${record.artifact.featureSchemaVersion}) does not match the compiler's current FEATURE_SCHEMA_VERSION (${FEATURE_SCHEMA_VERSION}).`,
    ),
    directCriterion(
      'shadow.2',
      'SHADOW',
      'Signed model artifact with compatible digest.',
      isSigned && held('redteam.artifact/weights-ref-digest-matches-artifact-sha256'),
      record === null
        ? notAdmittedDetail
        : isSigned
          ? "This model's artifact is signed (not the 'UNSIGNED' sentinel) and durably persisted (weightsRef non-null); redteam.artifact/weights-ref-digest-matches-artifact-sha256 proves weightsRef and sha256 can never diverge by construction."
          : `${modelRef} was admitted without a real signature or durable weights (bypassing admitModel()) — signature=${record.artifact.signature}, weightsRef=${record.artifact.weightsRef === null ? 'null' : 'present'}.`,
    ),
    evidenceCriterion(
      'shadow.3',
      'SHADOW',
      'No target/campaign leakage in dataset splits.',
      evidence.datasetLeakageCheck,
      (c) => c.clean,
      (c) =>
        c === undefined
          ? "no LeakageCheck evidence supplied — run training/splits.ts's checkNoLeakage() against this model's real dataset split and supply the result."
          : c.clean
            ? 'checkNoLeakage() reported no group overlap between train and holdout.'
            : `checkNoLeakage() reported overlapping groups: ${c.overlapping.join(', ')}`,
    ),
    directCriterion(
      'shadow.4',
      'SHADOW',
      'Utility label ownership and versioning.',
      DEFAULT_UTILITY_POLICY.policyVersion !== '' && evidence.utilityLabelOwnershipDocumented === true,
      DEFAULT_UTILITY_POLICY.policyVersion === ''
        ? 'UtilityLabelPolicy has no policyVersion set.'
        : evidence.utilityLabelOwnershipDocumented === true
          ? `UtilityLabelPolicy.policyVersion=${DEFAULT_UTILITY_POLICY.policyVersion} is real and versioned; ownership declared documented by caller.`
          : `UtilityLabelPolicy.policyVersion=${DEFAULT_UTILITY_POLICY.policyVersion} is real and versioned, but no owner field exists anywhere in this codebase — an organizational fact, not a code property. Supply utilityLabelOwnershipDocumented to assert it's documented elsewhere.`,
    ),
    evidenceCriterion(
      'shadow.5',
      'SHADOW',
      'Performance reported against simpler baselines.',
      evidence.baselineComparison,
      () => true,
      (c) =>
        c === undefined
          ? "no AdmissionGateResult evidence supplied — run training/admission-gate.ts's evaluateAdmissionGate() and supply the result."
          : `evaluateAdmissionGate() reported a real comparison against ${c.comparedAgainst.join(', ')} (beatsBestBaseline=${c.beatsBestBaseline}). This criterion asks only that a comparison was performed and reported, not that it won — see stop condition 18 for the win/lose gate.`,
    ),
    lawCriterion(
      'shadow.6',
      'SHADOW',
      'Deterministic inference for the same bound input.',
      'redteam.shadow/inference-is-deterministic-for-same-input',
      held,
    ),

    declaredCriterion(
      'experimental.1',
      'EXPERIMENTAL',
      'Positive lift in unique confirmed findings / 100 target calls.',
      evidence.uniqueFindingsLiftPer100Calls !== undefined && evidence.uniqueFindingsLiftPer100Calls > 0,
      'no lift metric computed anywhere in this repo — raw ingredients exist (confirmedFindingTargetProbes in features/history-view.ts) but no unique-findings-per-100-calls aggregation is built.',
    ),
    declaredCriterion(
      'experimental.2',
      'EXPERIMENTAL',
      'No regression in mandatory taxonomy coverage.',
      evidence.mandatoryTaxonomyCoverageRegressed === false,
      "no taxonomy-class-keyed coverage metric exists — pipeline/report.ts's buildCoverage()/CoverageReport is run-generic, not grouped by vulnerability class.",
    ),
    declaredCriterion(
      'experimental.3',
      'EXPERIMENTAL',
      'Bounded error and timeout rates.',
      evidence.errorAndTimeoutRatesWithinBounds,
      "no rate/threshold check exists — per-terminal-reason counts are real (settledAttemptsByReason, features/history-view.ts) but nothing aggregates them into a bounded rate.",
    ),
    lawCriterion('experimental.4', 'EXPERIMENTAL', 'Stale recommendations rejected in tests and replay.', 'redteam.planner/stale-recommendation-is-not-executed', held),
    directCriterion(
      'experimental.5',
      'EXPERIMENTAL',
      'Control/exploration share preserved.',
      held('redteam.planner/exploration-arm-never-disappears') && held('redteam.planner/control-arm-never-disappears'),
      `exploration-arm-never-disappears held=${held('redteam.planner/exploration-arm-never-disappears')}, control-arm-never-disappears held=${held('redteam.planner/control-arm-never-disappears')}`,
    ),
    lawCriterion(
      'experimental.6',
      'EXPERIMENTAL',
      'Worker-loss fallback demonstrated.',
      'redteam.planner/frozen-failure-falls-back-to-heuristic',
      held,
      "the model-inference-worker-unavailable fallback (shadow/rank.ts's rankCandidates() falling back to heuristicBaseline when the primary model throws) — matching §16's own §11 cross-reference (\"Frozen worker unavailable -> continue with deterministic heuristic planner\"), not the execution-lease reclaim mechanism, which answers a different 'worker died' question.",
    ),

    declaredCriterion(
      'calibrated.1',
      'CALIBRATED',
      'Sustained A/B gain across target and time holdouts.',
      evidence.sustainedAbGainAcrossHoldouts,
      "planner/ab.ts's evaluateABGate() computes exactly one model-vs-heuristic comparison over whatever outcomes are handed to it — no target-subset or time-window holdout dimension exists in that file or its tests.",
    ),
    declaredCriterion(
      'calibrated.2',
      'CALIBRATED',
      'Model and feature drift thresholds.',
      evidence.modelAndFeatureDriftWithinThresholds,
      "DRIFT_OR_QUALITY_REGRESSION (promotion/types.ts) is a manually-supplied promotion event — nothing computes when it should fire; no model-performance or feature-distribution drift detector exists anywhere.",
    ),
    declaredCriterion(
      'calibrated.3',
      'CALIBRATED',
      'Signed rollback target.',
      evidence.signedRollbackTargetAvailable,
      "signing exists (грань №16), but ModelPromotionRegistry stores exactly one artifact per modelRef forever — admit() never updates artifact_json, so there is no revert-to-prior-signed-weights mechanism.",
    ),
    directCriterion(
      'calibrated.4',
      'CALIBRATED',
      'Operator-visible reason codes and provenance.',
      provenanceComplete && evidence.unifiedReasonCodesAvailable === true,
      `${provenanceComplete ? 'provenance is real (same check as shadow.1)' : 'provenance is not complete (see shadow.1)'}; ${
        evidence.unifiedReasonCodesAvailable === true
          ? 'reason codes declared available'
          : "FrozenSignal.reasonCodes, modelSkipReason, and TransitionLogEntry.reason are separate, unconnected mechanisms — no unified reason-codes surface exists."
      }`,
    ),
    declaredCriterion(
      'calibrated.5',
      'CALIBRATED',
      'No critical-class false-negative or coverage regression beyond policy limits.',
      evidence.criticalClassRegressionWithinPolicy,
      "no 'critical-class' taxonomy concept and no policy-limit concept exist anywhere in this repo.",
    ),
  ];

  const stopConditions: StopCondition[] = [
    declaredStopCondition(
      'stop.1',
      'Model does not beat deterministic heuristic.',
      evidence.baselineComparison?.beatsBestBaseline,
      'evaluateAdmissionGate() reported beatsBestBaseline=true.',
      'evaluateAdmissionGate() reported beatsBestBaseline=false — the model does not beat the deterministic heuristic.',
      'no AdmissionGateResult evidence supplied.',
    ),
    declaredStopCondition(
      'stop.2',
      'Gains disappear on campaign/time holdout.',
      evidence.sustainedAbGainAcrossHoldouts,
      'sustained A/B gain across holdouts declared true.',
      'sustained A/B gain across holdouts declared false — gains do not survive a holdout.',
      'no holdout-gain evidence supplied — see calibrated.1 for the same underlying gap (no holdout dimension is computed anywhere).',
    ),
    lawStopCondition(
      'stop.3',
      'Ranking reduces coverage or exploration.',
      ['redteam.planner/exploration-arm-never-disappears', 'redteam.planner/control-arm-never-disappears'],
      held,
      'both arm-mix laws held — exploration and control arms are preserved.',
      'at least one arm-mix law did not hold.',
    ),
    declaredStopCondition(
      'stop.4',
      'Utility labels cannot be audited.',
      evidence.utilityLabelsAuditable,
      'utility label auditability declared true.',
      "utility label auditability declared false — training/dataset-exporter.ts's TrainingExample carries campaignId/targetId/probeId/occurredAt but no direct sourceObservationId, so a label traces to roughly where it came from, not to one specific Observation.",
      'no auditability evidence supplied.',
    ),
    lawStopCondition(
      'stop.5',
      'Replay produces different world fingerprint.',
      ['redteam.replay/same-events-produce-same-state', 'redteam.frozen/replaying-the-same-events-produces-the-same-fingerprint'],
      held,
      'both replay-fingerprint laws held.',
      'at least one replay-fingerprint law did not hold.',
    ),
    lawStopCondition(
      'stop.6',
      'Model output cannot be traced to complete binding.',
      'redteam.planner/stale-recommendation-is-not-executed',
      held,
      'RecommendationBinding/decideExecution() traces every executable recommendation to a complete binding — same mechanism as experimental.4.',
      'the binding-traceability law did not hold.',
    ),
  ];

  const anyStopTriggered = stopConditions.some((s) => s.status === 'TRIGGERED');
  const met = (tier: AdmissionTier): boolean => criteria.filter((c) => c.tier === tier).every((c) => c.status === 'MET');

  const shadowAdmissible = !anyStopTriggered && met('SHADOW');
  const experimentalAdmissible = shadowAdmissible && met('EXPERIMENTAL');
  const calibratedAdmissible = experimentalAdmissible && met('CALIBRATED');

  return { modelRef, criteria, stopConditions, shadowAdmissible, experimentalAdmissible, calibratedAdmissible };
}
