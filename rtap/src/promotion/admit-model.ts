import type { ArtifactStore } from '../artifacts/store.js';
import type { SigningAuthority } from '../signing/authority.js';
import { loadFittedLinearModel } from '../training/baselines/linear-regression-baseline.js';
import { packageLinearModelArtifact, serializeLinearModelWeights } from '../training/model-artifact.js';
import { signModelArtifact } from '../training/sign-model-artifact.js';
import type { ModelPromotionRegistry, PromotionRecord } from './registry.js';

/**
 * The config shape `promotion/cli.ts`'s `admit` subcommand parses from a JSON file —
 * the same `{kind, weights, bias}` weights shape `planner/cli.ts`'s `PlannerModelConfig`
 * already established (`linear-regression-baseline.ts`'s `loadFittedLinearModel()` is
 * the single place both CLIs reconstruct a model from serialized weights), plus the
 * metadata `packageLinearModelArtifact()` needs to build a real `SignedModelArtifact`.
 */
export interface AdmitModelConfig {
  readonly featureSchemaVersion: string;
  readonly taxonomyVersion: string;
  readonly trainingDatasetRef: string;
  readonly benchmarkRef: string;
  readonly issuer: string;
  readonly weights: { readonly weights: readonly number[]; readonly bias: number };
}

export interface AdmitModelResult {
  readonly record: PromotionRecord;
  readonly alreadyAdmitted: boolean;
  /**
   * `ModelPromotionRegistry.admit()` is intentionally idempotent by `modelRef` — it
   * keeps whatever artifact landed first and silently returns it for every later
   * call, never overwriting. That's the right behavior for a retried identical
   * `admit`, but a caller who genuinely means to admit a *different* model under a
   * `modelRef` they reused needs to know their new artifact was NOT the one that
   * actually landed — `true` here is that signal, compared by `sha256` (a real
   * content hash over the weights, not the metadata fields, which could differ
   * without the model itself changing).
   */
  readonly artifactMismatch: boolean;
}

/**
 * The composition `admit --config=...` needs: reconstruct a `FittedLinearModel` from
 * serialized weights, wrap it in a `SignedModelArtifact`, persist the weights
 * durably (`ArtifactStore.putWeights()`), sign the full envelope, and admit it —
 * kept separate from `promotion/cli.ts` so it can be exercised directly against a
 * real (in-memory) registry in tests, the same split `worker/promptfoo-worker.ts`
 * vs. `worker/cli.ts` and `planner/run-once.ts` vs. `planner/cli.ts` already
 * established.
 *
 * `weightsRef.ref` and `artifact.sha256` are guaranteed to encode the same digest
 * by construction — both are derived from one `serializeLinearModelWeights()` call,
 * never independently recomputed, so they cannot silently diverge
 * (`redteam.artifact/weights-ref-digest-matches-artifact-sha256`).
 *
 * Async, unlike the registry's own synchronous `admit()`/`applyEvent()`: durable
 * storage and signing are both real I/O (filesystem, and — for a future KMS
 * profile — network). `packageLinearModelArtifact()` itself stays synchronous and
 * unchanged; this function is the async composition layered on top of it.
 */
export async function admitModel(
  registry: ModelPromotionRegistry,
  artifactStore: ArtifactStore,
  signingAuthority: SigningAuthority,
  modelRef: string,
  config: AdmitModelConfig,
  now = new Date(),
): Promise<AdmitModelResult> {
  const fittedModel = loadFittedLinearModel(config.weights);
  const unsigned = packageLinearModelArtifact(
    fittedModel,
    {
      modelRef,
      featureSchemaVersion: config.featureSchemaVersion,
      taxonomyVersion: config.taxonomyVersion,
      trainingDatasetRef: config.trainingDatasetRef,
      benchmarkRef: config.benchmarkRef,
      issuer: config.issuer,
    },
    now,
  );

  const weightsRef = await artifactStore.putWeights(serializeLinearModelWeights(fittedModel));
  const signed = await signModelArtifact({ ...unsigned, weightsRef }, signingAuthority);

  const existing = registry.get(modelRef);
  const record = registry.admit(signed, now);

  return {
    record,
    alreadyAdmitted: existing !== null,
    artifactMismatch: existing !== null && existing.artifact.sha256 !== signed.sha256,
  };
}
