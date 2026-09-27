import { COORD, newVector, FEATURE_SCHEMA_VERSION } from './coordinates.js';
import { MISSING } from './missing.js';
import { hashBucket, normalizeCount, clamp01 } from './encoders.js';
import { vulnerabilityClassOf, strategyOf, targetProbeKey, type CampaignHistoryView } from './history-view.js';

export interface CandidateProbe {
  readonly probeId: string;
}

export interface BudgetState {
  readonly targetCallsUsed: number;
  readonly targetCallsBudget: number;
}

export interface CandidateForFeatures {
  readonly targetId: string;
  readonly probe: CandidateProbe;
  readonly budget: BudgetState;
}

export interface CandidateFeatureSnapshot {
  readonly featureSchemaVersion: string;
  readonly normalizationVersion: string;
  readonly taxonomyVersion: string;
  readonly compilerBuild: string;
  readonly featureView: 'CANDIDATE';
  readonly sourceObservationId: null;
  readonly candidateProbeId: string;
  /** The Target this candidate would run against — a candidate's identity is the (target, probe) pair, not the probe alone; see history-view.ts's targetProbeKey(). */
  readonly candidateTargetId: string;
  readonly vector: number[];
}

export const CANDIDATE_COMPILER_BUILD = 'candidate-fc-v1';
/** Named so a caller (planner/run-once.ts's taxonomyVersion cross-check) can reference the same value this compiler stamps, instead of duplicating the literal and risking silent drift if it ever changes. observation-compiler.ts declares its own copy independently — nothing requires the two compilers to agree, so this is not re-exported from there. */
export const CANDIDATE_TAXONOMY_VERSION = 'taxonomy-v1';

/**
 * CandidateFeatureCompiler — ADAPTIVE_REDTEAM_RUNTIME.md §4.4 view=CANDIDATE:
 * "describes a possible next RunStep". This function's whole reason to exist
 * separately from compileObservationFeatures is that it must be computable *before*
 * the candidate probe has been executed — its signature has no `verdict`, no
 * `provenance.graderKind`, nothing that could only be known after execution. If a
 * caller wants to feed post-hoc outcome data in here, that is exactly the mistake
 * §4.4 forbids: it would leak the label into the training input.
 *
 * GRADING (12-21) and RESPONSE_BEHAVIOR (0-11) and RUNTIME_AND_TRACE (22-31) are
 * therefore always MISSING here, structurally — there is no parameter this function
 * accepts that could populate them. See test/features/leakage.test.ts.
 */
export function compileCandidateFeatures(candidate: CandidateForFeatures, history: CampaignHistoryView): CandidateFeatureSnapshot {
  const vector = newVector(MISSING);
  const vulnClass = vulnerabilityClassOf(candidate.probe.probeId);
  const priorProbe = history.byTargetProbe.get(targetProbeKey(candidate.targetId, candidate.probe.probeId));
  const priorTarget = history.byTarget.get(candidate.targetId);

  // PROBE_AND_STRATEGY (32-41): identical encoding to the OBSERVATION view for the
  // same probeId — this is legitimately knowable in advance. Class, strategy and the
  // (class, strategy) pair each get their own coordinate — see the comment in
  // observation-compiler.ts for why the pair matters.
  const strategy = strategyOf(candidate.probe.probeId);
  vector[COORD.PROBE_AND_STRATEGY.start + 0] = hashBucket(vulnClass);
  vector[COORD.PROBE_AND_STRATEGY.start + 1] = hashBucket(strategy);
  vector[COORD.PROBE_AND_STRATEGY.start + 2] = hashBucket(candidate.probe.probeId);

  // CAMPAIGN_HISTORY (42-51): same shape as OBSERVATION's history coordinates, plus
  // BudgetState — FROZEN_INTEGRATION.md §4.2 has no dedicated group for budget, this
  // is the closest fit and is documented here rather than silently placed.
  vector[COORD.CAMPAIGN_HISTORY.start + 0] = normalizeCount(priorProbe?.committedOutcomes ?? 0, 10);
  vector[COORD.CAMPAIGN_HISTORY.start + 1] = history.vulnerabilityClassesSeen.has(vulnClass) ? 1 : 0;
  vector[COORD.CAMPAIGN_HISTORY.start + 2] = history.confirmedFindingTargetProbes.has(targetProbeKey(candidate.targetId, candidate.probe.probeId)) ? 1 : 0;
  vector[COORD.CAMPAIGN_HISTORY.start + 3] = normalizeCount(priorTarget?.committedOutcomes ?? 0, 20);
  vector[COORD.CAMPAIGN_HISTORY.start + 4] =
    candidate.budget.targetCallsBudget > 0
      ? clamp01(1 - candidate.budget.targetCallsUsed / candidate.budget.targetCallsBudget)
      : MISSING;

  // PROVENANCE_AND_QUALITY (52-59): nothing is known yet about how this candidate
  // will actually be graded — left MISSING, not guessed.

  return {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    normalizationVersion: 'norm-v1',
    taxonomyVersion: CANDIDATE_TAXONOMY_VERSION,
    compilerBuild: CANDIDATE_COMPILER_BUILD,
    featureView: 'CANDIDATE',
    sourceObservationId: null,
    candidateProbeId: candidate.probe.probeId,
    candidateTargetId: candidate.targetId,
    vector,
  };
}
