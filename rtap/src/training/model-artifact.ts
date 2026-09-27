import { createHash } from 'node:crypto';
import { validate } from '../schemas/index.js';
import type { WeightsRef } from '../artifacts/store.js';
import type { FittedLinearModel } from './baselines/linear-regression-baseline.js';

export interface SignedModelArtifact {
  readonly modelRef: string;
  readonly format: 'FZM' | 'FZA';
  readonly formatVersion: number;
  readonly sha256: string;
  readonly signature: string;
  readonly issuer: string;
  readonly createdAt: string;
  readonly coreFingerprint: string;
  readonly featureSchemaVersion: string;
  readonly taxonomyVersion: string;
  readonly trainingDatasetRef: string;
  readonly benchmarkRef: string;
  /**
   * грань №16: durable pointer to this artifact's weights in `ArtifactStore`,
   * content-addressed so `weightsRef.ref`'s digest and `sha256` above are never
   * independently computed — `admitModel()` derives both from the same
   * `serializeLinearModelWeights()` call, so they cannot silently diverge. `null`
   * from `packageLinearModelArtifact()` (which stays synchronous and does not touch
   * `ArtifactStore`); populated by `admitModel()`'s async orchestration.
   */
  readonly weightsRef: WeightsRef | null;
}

export interface SerializedWeights {
  readonly kind: 'linear-regression';
  readonly weights: readonly number[];
  readonly bias: number;
}

/** Pulled out of `packageLinearModelArtifact()` so `admitModel()` can hash-and-store
 * the exact same bytes via `ArtifactStore.putWeights()` without recomputing them. */
export function serializeLinearModelWeights(model: FittedLinearModel): string {
  const weights: SerializedWeights = { kind: 'linear-regression', weights: model.weights, bias: model.bias };
  return JSON.stringify(weights);
}

/**
 * FROZEN_INTEGRATION.md §9: "FZM/FZA checksum/fingerprint establishes compatibility
 * ... not authenticity." This wraps a fitted baseline's weights in the same
 * SignedModelArtifact envelope real frozen artifacts use, with a genuine SHA-256
 * over the serialized weights — not a placeholder string. `signature`/`issuer` are
 * NOT produced here: signing authority is an open decision (FROZEN_INTEGRATION.md
 * §13.7), so this artifact is legitimately unsigned and must not be treated as
 * admissible past SHADOW until that's resolved — see the `signature: 'UNSIGNED'`
 * sentinel below, not a fabricated one.
 */
export function packageLinearModelArtifact(
  model: FittedLinearModel,
  ctx: { readonly modelRef: string; readonly featureSchemaVersion: string; readonly taxonomyVersion: string; readonly trainingDatasetRef: string; readonly benchmarkRef: string; readonly issuer: string },
  now = new Date(),
): SignedModelArtifact {
  const serialized = serializeLinearModelWeights(model);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const coreFingerprint = createHash('sha1').update(serialized).digest('hex').slice(0, 16); // compatibility-only, per §9 — deliberately weaker/shorter than sha256

  const artifact: SignedModelArtifact = {
    modelRef: ctx.modelRef,
    format: 'FZM',
    formatVersion: 1,
    sha256,
    signature: 'UNSIGNED',
    issuer: ctx.issuer,
    createdAt: now.toISOString(),
    coreFingerprint,
    featureSchemaVersion: ctx.featureSchemaVersion,
    taxonomyVersion: ctx.taxonomyVersion,
    trainingDatasetRef: ctx.trainingDatasetRef,
    benchmarkRef: ctx.benchmarkRef,
    weightsRef: null,
  };

  const check = validate('rtap:model-snapshot', artifact);
  if (!check.valid) {
    throw new Error(`Packaged model artifact does not conform to rtap:model-snapshot: ${check.errors.join('; ')}`);
  }
  return artifact;
}
