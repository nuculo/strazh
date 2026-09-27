import { COORD, newVector, FEATURE_SCHEMA_VERSION } from './coordinates.js';
import { MISSING } from './missing.js';
import { engineTrust, graderKindStrength, verdictScore, hashBucket, normalizeCount } from './encoders.js';
import { vulnerabilityClassOf, strategyOf, targetProbeKey, type CampaignHistoryView } from './history-view.js';

export interface ObservationForFeatures {
  readonly id: string;
  readonly targetId: string;
  readonly probeId: string;
  readonly verdict: string;
  readonly provenance: {
    readonly engineId: string;
    readonly graderKind: string;
    readonly configIgnored: boolean;
  };
}

export interface ObservationFeatureSnapshot {
  readonly featureSchemaVersion: string;
  readonly normalizationVersion: string;
  readonly taxonomyVersion: string;
  readonly compilerBuild: string;
  readonly featureView: 'OBSERVATION';
  readonly sourceObservationId: string;
  readonly candidateProbeId: null;
  readonly candidateTargetId: null;
  readonly vector: number[];
}

export const OBSERVATION_COMPILER_BUILD = 'observation-fc-v1';

/**
 * ObservationFeatureCompiler — FROZEN_INTEGRATION.md §4.1 `compileObservation`,
 * ADAPTIVE_REDTEAM_RUNTIME.md §4.4 view=OBSERVATION: "describes evidence already
 * obtained". Deterministic, total, pure — same inputs always produce the same
 * vector. `history` must be built as-of strictly before this Observation's own
 * committed event (see history-view.ts) so this compiler cannot see its own effect
 * on the campaign history it reads.
 */
export function compileObservationFeatures(
  observation: ObservationForFeatures,
  history: CampaignHistoryView,
): ObservationFeatureSnapshot {
  const vector = newVector(MISSING);
  const vulnClass = vulnerabilityClassOf(observation.probeId);
  const priorProbe = history.byTargetProbe.get(targetProbeKey(observation.targetId, observation.probeId));
  const priorTarget = history.byTarget.get(observation.targetId);

  // GRADING (12-21): this view is allowed to see the actual outcome — that is the
  // entire point of the OBSERVATION view existing.
  vector[COORD.GRADING.start + 0] = observation.provenance.graderKind === 'none' ? 0 : 1; // grader ran
  vector[COORD.GRADING.start + 1] = graderKindStrength(observation.provenance.graderKind);
  const score = verdictScore(observation.verdict);
  vector[COORD.GRADING.start + 2] = score ?? MISSING;

  // PROBE_AND_STRATEGY (32-41): a priori-knowable metadata, same slots CANDIDATE uses.
  // Three distinct hashes: class alone, strategy alone, and the (class, strategy)
  // pair — the pair matters because delivery-technique effects are frequently
  // strategy-specific *within* a class (e.g. base64 succeeding far more than a
  // plain request for the same vulnerability class), and a linear model can only
  // assign weight to an interaction it is actually given as its own coordinate.
  const strategy = strategyOf(observation.probeId);
  vector[COORD.PROBE_AND_STRATEGY.start + 0] = hashBucket(vulnClass);
  vector[COORD.PROBE_AND_STRATEGY.start + 1] = hashBucket(strategy);
  vector[COORD.PROBE_AND_STRATEGY.start + 2] = hashBucket(observation.probeId);

  // CAMPAIGN_HISTORY (42-51): state of the campaign *before* this Observation.
  vector[COORD.CAMPAIGN_HISTORY.start + 0] = normalizeCount(priorProbe?.committedOutcomes ?? 0, 10);
  vector[COORD.CAMPAIGN_HISTORY.start + 1] = history.vulnerabilityClassesSeen.has(vulnClass) ? 1 : 0;
  vector[COORD.CAMPAIGN_HISTORY.start + 2] = history.confirmedFindingTargetProbes.has(targetProbeKey(observation.targetId, observation.probeId)) ? 1 : 0;
  vector[COORD.CAMPAIGN_HISTORY.start + 3] = normalizeCount(priorTarget?.committedOutcomes ?? 0, 20);

  // PROVENANCE_AND_QUALITY (52-59).
  vector[COORD.PROVENANCE_AND_QUALITY.start + 0] = engineTrust(observation.provenance.engineId);
  vector[COORD.PROVENANCE_AND_QUALITY.start + 1] = observation.provenance.configIgnored ? 0 : 1;

  return {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    normalizationVersion: 'norm-v1',
    taxonomyVersion: 'taxonomy-v1',
    compilerBuild: OBSERVATION_COMPILER_BUILD,
    featureView: 'OBSERVATION',
    sourceObservationId: observation.id,
    candidateProbeId: null,
    candidateTargetId: null,
    vector,
  };
}
