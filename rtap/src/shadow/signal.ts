import type { CandidateFeatureSnapshot } from '../features/candidate-compiler.js';
import type { FittedModel } from '../training/baselines/types.js';

/**
 * FROZEN_INTEGRATION.md §5.4's seven `FrozenSignal.kind` values, minus `ANOMALY` —
 * "Undefined — only graph/state primitives exist today, no detection logic...
 * BUILD/DEFER, no committed mechanism", explicitly gated behind a separate
 * Research gate (§12), not part of F5. The other six are real here: `PROBE_UTILITY`
 * (a trained model, `shadow/signal.ts`'s own `scoreCandidate()`, since Phase 3) and
 * five F5 additions that are all deterministic or statistical computations over the
 * same CampaignWorld/Observation substrate the model also reads — "reaching F5 does
 * not require a second trained model" (§5.4's own text). `RETEST_PRIORITY` is
 * declared here (the full six-value union is what the doc specifies) but has no
 * producer yet — `world/state.ts` documents episodic memory
 * (`GraphMessage`) as real, not attempted; see rtap/README.md's Phase 5 section.
 */
export type FrozenSignalKind = 'PROBE_UTILITY' | 'SATURATION' | 'TARGET_DRIFT' | 'RISK_TREND' | 'GRADER_DISAGREEMENT' | 'RETEST_PRIORITY';

export interface FrozenSignal {
  readonly kind: FrozenSignalKind;
  readonly subjectRef: string;
  /** The Target this signal's candidate would run against — see candidate-compiler.ts's candidateTargetId; a probe-only subjectRef was a real cross-target ambiguity bug found by audit. */
  readonly targetId: string;
  readonly value: number;
  readonly quality: 'SHADOW' | 'EXPERIMENTAL' | 'CALIBRATED';
  readonly reasonCodes: string[];
  readonly evidenceObservationIds: string[];
  readonly modelRef: string;
  readonly adapterRef: null;
  readonly featureSnapshotRef: string;
  readonly worldGeneration: number;
  readonly worldEpoch: number;
}

export interface WorldPosition {
  readonly worldGeneration: number;
  readonly worldEpoch: number;
}

/**
 * A deterministic, synthesized ref — this repo has no FeatureSnapshot store yet
 * (that's a real gap, not hidden: without one, two identical candidate vectors at
 * different times cannot be deduplicated or looked back up by ref). Documented
 * placeholder scheme, not presented as a real content-addressed store.
 */
function syntheticFeatureSnapshotRef(features: CandidateFeatureSnapshot): string {
  return `${features.compilerBuild}:${features.candidateProbeId}:${features.featureSchemaVersion}`;
}

/**
 * FROZEN_INTEGRATION.md §5.4 / ADAPTIVE_REDTEAM_RUNTIME.md §8: produces the advisory
 * signal for one candidate. `quality` is always the promotion state's own quality —
 * a SHADOW-state model can never emit an EXPERIMENTAL/CALIBRATED signal, so the
 * consumer's trust level is tied to the registry, not to what the caller claims.
 */
export function scoreCandidate(
  model: FittedModel,
  modelRef: string,
  features: CandidateFeatureSnapshot,
  world: WorldPosition,
  quality: FrozenSignal['quality'],
): FrozenSignal {
  return {
    kind: 'PROBE_UTILITY',
    subjectRef: features.candidateProbeId,
    targetId: features.candidateTargetId,
    value: model.predict(features),
    quality,
    reasonCodes: [`model:${model.name}`],
    evidenceObservationIds: [],
    modelRef,
    adapterRef: null,
    featureSnapshotRef: syntheticFeatureSnapshotRef(features),
    worldGeneration: world.worldGeneration,
    worldEpoch: world.worldEpoch,
  };
}
