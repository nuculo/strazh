import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mulberry32, pick, randFloat, randInt } from '../rng.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { ModelPromotionRegistry } from '../../promotion/registry.js';
import { attemptModelTransition, type SignatureGate } from '../../promotion/types.js';
import { findModelsOnRevokedKeys, sweepRevokedKeyDemotions } from '../../promotion/revocation-sweep.js';
import { LocalKeypairSigningAuthority } from '../../signing/local-keypair-authority.js';
import { KeyStoreVerifyingSigningAuthority } from '../../signing/key-store-verifying-authority.js';
import { SigningKeyStore } from '../../signing/key-store.js';
import { SigningKeyUnavailableError, UnsupportedSignatureSchemeError } from '../../signing/authority.js';
import { FilesystemArtifactStore } from '../../artifacts/filesystem-store.js';
import { packageLinearModelArtifact, serializeLinearModelWeights, type SignedModelArtifact } from '../../training/model-artifact.js';
import { signModelArtifact } from '../../training/sign-model-artifact.js';
import type { FittedLinearModel } from '../../training/baselines/linear-regression-baseline.js';
import type { SecretProvider, ResolvedSecret } from '../../secrets/provider.js';
import type { Law } from '../types.js';

// грань №16: model-signing-authority. No prior document names IDs for any of
// these — derived directly from FROZEN_INTEGRATION.md §13.7's "signing authority
// is an open decision" and this facet's own design.

class StaticSecretProvider implements SecretProvider {
  constructor(private readonly values: Readonly<Record<string, string>>) {}
  async resolve(secretRef: string): Promise<ResolvedSecret> {
    const value = this.values[secretRef];
    if (value === undefined) throw new Error(`StaticSecretProvider: no value configured for ${secretRef}`);
    return { value };
  }
}

function freshKeyPairPem(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function fullAuthority(privatePem: string, publicPem: string): LocalKeypairSigningAuthority {
  return new LocalKeypairSigningAuthority({
    secretProvider: new StaticSecretProvider({ priv: privatePem, pub: publicPem }),
    keyId: 'law-key',
    privateKeySecretRef: 'priv',
    publicKeySecretRef: 'pub',
  });
}

function verifyOnlyAuthority(publicPem: string): LocalKeypairSigningAuthority {
  return new LocalKeypairSigningAuthority({
    secretProvider: new StaticSecretProvider({ pub: publicPem }),
    keyId: 'law-key',
    publicKeySecretRef: 'pub',
  });
}

/**
 * грань №18: a fresh in-memory `SigningKeyStore` with `n` freshly-generated
 * Ed25519 keys already registered under caller-chosen ids, sharing ONE
 * `StaticSecretProvider` (built once, over every key's PEM material, so a
 * `KeyStoreVerifyingSigningAuthority` backed by this env can resolve any of
 * them) plus a sign-mode `LocalKeypairSigningAuthority` per key for producing
 * real signatures in tests.
 */
function keyStoreEnv(keyIds: readonly string[]): { keyStore: SigningKeyStore; secretProvider: StaticSecretProvider; sign: ReadonlyMap<string, LocalKeypairSigningAuthority> } {
  const keyStore = new SigningKeyStore(openInMemoryDatabase());
  const secrets: Record<string, string> = {};
  const pems = keyIds.map((keyId) => ({ keyId, ...freshKeyPairPem() }));
  for (const { keyId, privatePem, publicPem } of pems) {
    secrets[`${keyId}-priv`] = privatePem;
    secrets[`${keyId}-pub`] = publicPem;
  }
  const secretProvider = new StaticSecretProvider(secrets);
  const sign = new Map<string, LocalKeypairSigningAuthority>();
  for (const { keyId } of pems) {
    keyStore.register(keyId, 'local-ed25519', `${keyId}-pub`, null, null);
    sign.set(keyId, new LocalKeypairSigningAuthority({ secretProvider, keyId, privateKeySecretRef: `${keyId}-priv` }));
  }
  return { keyStore, secretProvider, sign };
}

/** Each trial gets its own temp dir — same lifetime discipline `production-profile.laws.ts`'s `withTempArtifactStore()` already established; no live S3 to point this at instead. */
async function withTempArtifactStore<T>(fn: (store: FilesystemArtifactStore) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'rtap-law-signing-'));
  try {
    return await fn(new FilesystemArtifactStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function randomArtifact(rng: () => number): SignedModelArtifact {
  const model = randomFittedModel(rng);
  return packageLinearModelArtifact(model, {
    modelRef: `law-model-${randInt(rng, 1, 1_000_000)}`,
    featureSchemaVersion: '1.0.0',
    taxonomyVersion: `taxonomy-${randInt(rng, 1, 5)}`,
    trainingDatasetRef: `ds-${randInt(rng, 1, 5)}`,
    benchmarkRef: `bench-${randInt(rng, 1, 5)}`,
    issuer: `issuer-${randInt(rng, 1, 5)}`,
  });
}

function randomFittedModel(rng: () => number): FittedLinearModel {
  const dim = randInt(rng, 1, 5);
  return {
    name: 'law-fixture',
    predict: () => 0,
    weights: Array.from({ length: dim }, () => randFloat(rng, -1, 1)),
    bias: randFloat(rng, -1, 1),
  };
}

type CanonicalField =
  | 'modelRef'
  | 'format'
  | 'formatVersion'
  | 'sha256'
  | 'issuer'
  | 'createdAt'
  | 'coreFingerprint'
  | 'featureSchemaVersion'
  | 'taxonomyVersion'
  | 'trainingDatasetRef'
  | 'benchmarkRef'
  | 'weightsRef';

const CANONICAL_FIELDS: readonly CanonicalField[] = [
  'modelRef',
  'format',
  'formatVersion',
  'sha256',
  'issuer',
  'createdAt',
  'coreFingerprint',
  'featureSchemaVersion',
  'taxonomyVersion',
  'trainingDatasetRef',
  'benchmarkRef',
  'weightsRef',
];

/** Mutates exactly the fields `canonicalizeArtifactForSigning()` binds into the signature — the tamper surface a signed-envelope (not bare-digest) scheme is meant to close. */
function corruptField(artifact: SignedModelArtifact, field: CanonicalField): SignedModelArtifact {
  switch (field) {
    case 'modelRef':
      return { ...artifact, modelRef: `${artifact.modelRef}-x` };
    case 'format':
      return { ...artifact, format: artifact.format === 'FZM' ? 'FZA' : 'FZM' };
    case 'formatVersion':
      return { ...artifact, formatVersion: artifact.formatVersion + 1 };
    case 'sha256':
      return { ...artifact, sha256: `${artifact.sha256.slice(1)}0` };
    case 'issuer':
      return { ...artifact, issuer: `${artifact.issuer}-x` };
    case 'createdAt':
      return { ...artifact, createdAt: new Date(Date.parse(artifact.createdAt) + 1000).toISOString() };
    case 'coreFingerprint':
      return { ...artifact, coreFingerprint: `${artifact.coreFingerprint}-x` };
    case 'featureSchemaVersion':
      return { ...artifact, featureSchemaVersion: `${artifact.featureSchemaVersion}-x` };
    case 'taxonomyVersion':
      return { ...artifact, taxonomyVersion: `${artifact.taxonomyVersion}-x` };
    case 'trainingDatasetRef':
      return { ...artifact, trainingDatasetRef: `${artifact.trainingDatasetRef}-x` };
    case 'benchmarkRef':
      return { ...artifact, benchmarkRef: `${artifact.benchmarkRef}-x` };
    case 'weightsRef':
      return { ...artifact, weightsRef: artifact.weightsRef === null ? { ref: `local:sha256:${'0'.repeat(64)}`, kind: 'model-weights' } : null };
  }
}

export const signingLaws: Law[] = [
  {
    id: 'redteam.signing/sign-then-verify-roundtrips',
    statement:
      'LocalKeypairSigningAuthority.verify() holds for a signature produced by .sign() over the same canonicalized artifact; mutating any single field of the signed envelope bound by canonicalizeArtifactForSigning() (modelRef, format, formatVersion, sha256, issuer, createdAt, coreFingerprint, featureSchemaVersion, taxonomyVersion, trainingDatasetRef, benchmarkRef, or weightsRef) always makes verify() return valid:false.',
    status: 'implemented',
    trials: 100,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { privatePem, publicPem } = freshKeyPairPem();
      const authority = fullAuthority(privatePem, publicPem);

      const base = randomArtifact(rng);
      const signed = await signModelArtifact(base, authority);
      const { signature, ...withoutSignature } = signed;
      const roundTrip = await authority.verify({ artifact: withoutSignature, signature });
      if (!roundTrip.valid) {
        return { held: false, detail: 'a freshly signed artifact failed to round-trip through verify()', counterexample: { seed, reason: roundTrip.reason } };
      }

      const field = pick(rng, CANONICAL_FIELDS);
      const tampered = corruptField(signed, field);
      const { signature: tamperedSignature, ...tamperedWithoutSignature } = tampered;
      const tamperResult = await authority.verify({ artifact: tamperedWithoutSignature, signature: tamperedSignature });
      if (tamperResult.valid) {
        return { held: false, detail: `verify() accepted a signature after mutating "${field}"`, counterexample: { seed, field } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/verify-only-authority-cannot-sign',
    statement:
      'A LocalKeypairSigningAuthority constructed with only publicKeySecretRef throws SigningKeyUnavailableError from sign(), for any artifact — and its verify() still succeeds against a signature produced by a sign-mode authority holding the matching private key. The split-operator property this design is named for: the process gating promotion never holds forging capability.',
    status: 'implemented',
    trials: 60,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { privatePem, publicPem } = freshKeyPairPem();
      const signAuthority = fullAuthority(privatePem, publicPem);
      const verifyOnly = verifyOnlyAuthority(publicPem);

      const base = randomArtifact(rng);
      let threw = false;
      try {
        await verifyOnly.sign({ artifact: base });
      } catch (err) {
        threw = err instanceof SigningKeyUnavailableError;
      }
      if (!threw) {
        return { held: false, detail: 'a verify-only authority did not throw SigningKeyUnavailableError from sign()', counterexample: { seed } };
      }

      const signed = await signModelArtifact(base, signAuthority);
      const { signature, ...withoutSignature } = signed;
      const verifyResult = await verifyOnly.verify({ artifact: withoutSignature, signature });
      if (!verifyResult.valid) {
        return { held: false, detail: 'verify-only authority failed to verify a signature from the matching sign-mode authority', counterexample: { seed, reason: verifyResult.reason } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/unsupported-signature-is-rejected-not-ignored',
    statement:
      "verify() throws UnsupportedSignatureSchemeError — never returns valid:false — for any signature string that is not a well-formed local-ed25519:<keyId>:<base64> triple, including the literal 'UNSIGNED' sentinel. An unrecognized scheme is loud, mirroring EnvSecretProvider's treatment of vault:/kms:.",
    status: 'implemented',
    trials: 60,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { publicPem } = freshKeyPairPem();
      const authority = verifyOnlyAuthority(publicPem);
      const base = randomArtifact(rng);
      const { signature: _drop, ...withoutSignature } = base;

      const badSignature = pick(rng, ['UNSIGNED', `garbage-${randInt(rng, 1, 1_000_000)}`, '']);
      let threw = false;
      try {
        await authority.verify({ artifact: withoutSignature, signature: badSignature });
      } catch (err) {
        threw = err instanceof UnsupportedSignatureSchemeError;
      }
      if (!threw) {
        return { held: false, detail: `verify() did not throw UnsupportedSignatureSchemeError for "${badSignature}"`, counterexample: { seed, badSignature } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.artifact/weights-ref-digest-matches-artifact-sha256',
    statement:
      'For any FittedLinearModel, ArtifactStore.putWeights(serializeLinearModelWeights(model)).ref always encodes the same sha256 hex digest that packageLinearModelArtifact(model, ctx).sha256 reports — the two are never independently computed, so they cannot silently diverge.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) =>
      withTempArtifactStore(async (store) => {
        const rng = mulberry32(seed);
        const model = randomFittedModel(rng);
        const artifact = packageLinearModelArtifact(model, {
          modelRef: 'law-model',
          featureSchemaVersion: '1.0.0',
          taxonomyVersion: 'taxonomy-v1',
          trainingDatasetRef: 'ds-1',
          benchmarkRef: 'bench-1',
          issuer: 'issuer-1',
        });
        const weightsRef = await store.putWeights(serializeLinearModelWeights(model));
        const expectedRef = `local:sha256:${artifact.sha256}`;
        if (weightsRef.ref !== expectedRef) {
          return { held: false, detail: "putWeights()'s ref digest does not match packageLinearModelArtifact()'s sha256", counterexample: { seed, weightsRef: weightsRef.ref, expected: expectedRef } };
        }
        return { held: true };
      }),
  },
  {
    id: 'redteam.promotion/shadow-requires-verified-signature',
    statement:
      'ModelPromotionRegistry.applyEvent() never returns allowed:true for MODEL_ADMITTED unless given a SignatureGate with verified:true — an absent gate, an explicitly unverified gate, and one carrying a reason all refuse identically, and the record stays at OFF. Enforced inside applyEvent() itself (attemptModelTransition()), not only by a caller convention above it.',
    status: 'implemented',
    trials: 60,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const registry = new ModelPromotionRegistry(openInMemoryDatabase());
      const artifact = randomArtifact(rng);
      registry.admit(artifact);

      const gateChoice = randInt(rng, 0, 2);
      const signature: SignatureGate | undefined = gateChoice === 0 ? undefined : gateChoice === 1 ? { verified: false } : { verified: false, reason: 'law-injected-reason' };

      const entry = registry.applyEvent(artifact.modelRef, 'MODEL_ADMITTED', signature);
      if (entry.allowed) {
        return { held: false, detail: 'applyEvent() allowed MODEL_ADMITTED without a verified SignatureGate', counterexample: { seed, gateChoice } };
      }
      if (registry.get(artifact.modelRef)?.state !== 'OFF') {
        return { held: false, detail: 'state moved despite a refused transition', counterexample: { seed, gateChoice, state: registry.get(artifact.modelRef)?.state } };
      }
      return { held: true };
    },
  },
  // грань №18: key rotation and revocation. No prior document names IDs for
  // these either — derived from this facet's own design.
  {
    id: 'redteam.signing/keystore-resolves-by-embedded-keyid',
    statement:
      'A single KeyStoreVerifyingSigningAuthority backed by a SigningKeyStore holding two distinct registered keys verifies a signature produced under either key correctly — resolution is driven by the keyId embedded in the signature itself, not by whichever key the caller happens to have configured.',
    status: 'implemented',
    trials: 60,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { keyStore, secretProvider, sign } = keyStoreEnv(['key-a', 'key-b']);
      const verifier = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });

      const signedA = await signModelArtifact(randomArtifact(rng), sign.get('key-a')!);
      const signedB = await signModelArtifact(randomArtifact(rng), sign.get('key-b')!);
      const { signature: sigA, ...withoutA } = signedA;
      const { signature: sigB, ...withoutB } = signedB;

      const resultA = await verifier.verify({ artifact: withoutA, signature: sigA });
      const resultB = await verifier.verify({ artifact: withoutB, signature: sigB });
      if (!resultA.valid || !resultB.valid) {
        return { held: false, detail: 'one signature failed to verify through the shared store-backed authority', counterexample: { seed, resultA, resultB } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/unknown-keyid-fails-closed',
    statement:
      "KeyStoreVerifyingSigningAuthority.verify() returns valid:false (never throws, never treats it as valid) for a well-formed signature whose keyId was never registered in the store — the refusal reason names the unknown keyId.",
    status: 'implemented',
    trials: 60,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { keyStore, secretProvider } = keyStoreEnv(['registered-key']);
      const stranger = freshKeyPairPem();
      const strangerAuthority = fullAuthority(stranger.privatePem, stranger.publicPem); // keyId 'law-key', never registered here

      const signed = await signModelArtifact(randomArtifact(rng), strangerAuthority);
      const verifier = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });
      const { signature, ...withoutSignature } = signed;
      const result = await verifier.verify({ artifact: withoutSignature, signature });

      if (result.valid) {
        return { held: false, detail: 'verify() accepted a signature from an unregistered keyId', counterexample: { seed } };
      }
      if (!result.reason?.includes('unknown keyId')) {
        return { held: false, detail: 'refusal reason does not name the unknown keyId', counterexample: { seed, reason: result.reason } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/rotation-preserves-old-key-verifiability',
    statement:
      "Registering a new signing key (rotation) never affects verification of an artifact already signed under an earlier, still-registered key — verify() resolves strictly by the signature's own embedded keyId, so a later registration is invisible to it.",
    status: 'implemented',
    trials: 60,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { keyStore, secretProvider, sign } = keyStoreEnv(['key-old']);
      const signed = await signModelArtifact(randomArtifact(rng), sign.get('key-old')!);
      const verifier = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });
      const { signature, ...withoutSignature } = signed;

      const before = await verifier.verify({ artifact: withoutSignature, signature });
      if (!before.valid) {
        return { held: false, detail: 'signature failed to verify before any rotation happened', counterexample: { seed, reason: before.reason } };
      }

      // "Rotation" = registering a new key. The old key's row is never touched.
      keyStore.register(`key-new-${seed}`, 'local-ed25519', 'irrelevant-ref', null, null);

      const after = await verifier.verify({ artifact: withoutSignature, signature });
      if (!after.valid) {
        return { held: false, detail: 'registering a new key broke verification of a signature under the old key', counterexample: { seed, reason: after.reason } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/revoked-key-fails-verification',
    statement:
      'A signature that verifies under a key becomes valid:false, with a reason naming the revocation, immediately after that key is revoked — the same signature, unchanged, is never re-verified successfully again.',
    status: 'implemented',
    trials: 60,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const { keyStore, secretProvider, sign } = keyStoreEnv(['key-to-revoke']);
      const signed = await signModelArtifact(randomArtifact(rng), sign.get('key-to-revoke')!);
      const verifier = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });
      const { signature, ...withoutSignature } = signed;

      const before = await verifier.verify({ artifact: withoutSignature, signature });
      if (!before.valid) {
        return { held: false, detail: 'signature failed to verify before revocation', counterexample: { seed, reason: before.reason } };
      }

      keyStore.revoke('key-to-revoke', 'law-test-revocation', null);

      const after = await verifier.verify({ artifact: withoutSignature, signature });
      if (after.valid) {
        return { held: false, detail: 'verify() accepted a signature from a revoked key', counterexample: { seed } };
      }
      if (!after.reason?.toLowerCase().includes('revoked')) {
        return { held: false, detail: 'refusal reason does not mention revocation', counterexample: { seed, reason: after.reason } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.promotion/ab-gates-passed-blocked-by-revoked-key',
    statement:
      'attemptModelTransition() never returns allowed:true for AB_GATES_PASSED from EXPERIMENTAL unless given a SignatureGate with verified:true — an absent gate, an explicitly unverified gate, and one carrying a revocation reason all refuse identically, and the state stays EXPERIMENTAL.',
    status: 'implemented',
    trials: 60,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const gateChoice = randInt(rng, 0, 2);
      const signature: SignatureGate | undefined =
        gateChoice === 0 ? undefined : gateChoice === 1 ? { verified: false } : { verified: false, reason: 'signing key was revoked' };

      const result = attemptModelTransition('EXPERIMENTAL', 'AB_GATES_PASSED', signature);
      if (result.allowed) {
        return { held: false, detail: 'attemptModelTransition() allowed AB_GATES_PASSED without a verified SignatureGate', counterexample: { seed, gateChoice } };
      }
      if (result.to !== 'EXPERIMENTAL') {
        return { held: false, detail: 'refused transition did not leave state at EXPERIMENTAL', counterexample: { seed, to: result.to } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.promotion/offline-and-shadow-gates-passed-ungated-by-signature',
    statement:
      "attemptModelTransition('SHADOW', 'OFFLINE_AND_SHADOW_GATES_PASSED', signature) always succeeds (allowed:true, to:EXPERIMENTAL) regardless of the SignatureGate passed — undefined, verified:true, or verified:false — pinning the deliberate choice that this event stays outside SIGNATURE_GATED_EVENTS, so a future edit can't silently widen or narrow the gated set without a law failing.",
    status: 'implemented',
    trials: 60,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const choice = randInt(rng, 0, 2);
      const signature: SignatureGate | undefined = choice === 0 ? undefined : choice === 1 ? { verified: true } : { verified: false, reason: 'irrelevant' };

      const result = attemptModelTransition('SHADOW', 'OFFLINE_AND_SHADOW_GATES_PASSED', signature);
      if (!result.allowed || result.to !== 'EXPERIMENTAL') {
        return { held: false, detail: 'OFFLINE_AND_SHADOW_GATES_PASSED was blocked or misrouted by a SignatureGate it should ignore entirely', counterexample: { seed, choice, result } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/sweep-uses-legal-edges-per-state',
    statement:
      'sweepRevokedKeyDemotions() drives every model on a revoked key to OFF using only legal TRANSITIONS edges: one hop (INTEGRITY_OR_POLICY_FAILURE) from CALIBRATED, one hop (ARTIFACT_OR_SCHEMA_INVALID) from SHADOW, and two hops (SAFETY_OR_COVERAGE_REGRESSION then ARTIFACT_OR_SCHEMA_INVALID) from EXPERIMENTAL — never attempting an edge TRANSITIONS does not declare.',
    status: 'implemented',
    trials: 30,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const keyId = `sweep-key-${seed}`;
      const { keyStore, secretProvider, sign } = keyStoreEnv([keyId]);
      const authority = sign.get(keyId)!;
      const verifier = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });
      const registry = new ModelPromotionRegistry(openInMemoryDatabase());

      async function admitAndPromoteTo(modelRef: string, target: 'SHADOW' | 'EXPERIMENTAL' | 'CALIBRATED'): Promise<void> {
        const artifact: SignedModelArtifact = { ...randomArtifact(rng), modelRef };
        const signed = await signModelArtifact(artifact, authority);
        registry.admit(signed);
        const { signature, ...withoutSignature } = signed;
        const verifyResult = await verifier.verify({ artifact: withoutSignature, signature });
        const gate: SignatureGate = verifyResult.valid ? { verified: true } : { verified: false, reason: verifyResult.reason ?? 'signature does not verify' };
        registry.applyEvent(modelRef, 'MODEL_ADMITTED', gate);
        if (target === 'SHADOW') return;
        registry.applyEvent(modelRef, 'OFFLINE_AND_SHADOW_GATES_PASSED');
        if (target === 'EXPERIMENTAL') return;
        registry.applyEvent(modelRef, 'AB_GATES_PASSED', gate);
      }

      const calibratedRef = `sweep-calibrated-${seed}`;
      const shadowRef = `sweep-shadow-${seed}`;
      const experimentalRef = `sweep-experimental-${seed}`;
      await admitAndPromoteTo(calibratedRef, 'CALIBRATED');
      await admitAndPromoteTo(shadowRef, 'SHADOW');
      await admitAndPromoteTo(experimentalRef, 'EXPERIMENTAL');

      keyStore.revoke(keyId, 'law-test-sweep-revocation', null);

      const affected = findModelsOnRevokedKeys(registry.listAll(), keyStore);
      if (affected.length !== 3) {
        return { held: false, detail: `expected 3 affected models, found ${affected.length}`, counterexample: { seed, affected } };
      }

      const entries = sweepRevokedKeyDemotions(registry, keyStore);
      const eventsFor = (ref: string) => entries.filter((e) => e.modelRef === ref).map((e) => e.event);

      const calibratedEvents = eventsFor(calibratedRef);
      const shadowEvents = eventsFor(shadowRef);
      const experimentalEvents = eventsFor(experimentalRef);

      if (JSON.stringify(calibratedEvents) !== JSON.stringify(['INTEGRITY_OR_POLICY_FAILURE'])) {
        return { held: false, detail: 'CALIBRATED model was not swept via a single INTEGRITY_OR_POLICY_FAILURE hop', counterexample: { seed, calibratedEvents } };
      }
      if (JSON.stringify(shadowEvents) !== JSON.stringify(['ARTIFACT_OR_SCHEMA_INVALID'])) {
        return { held: false, detail: 'SHADOW model was not swept via a single ARTIFACT_OR_SCHEMA_INVALID hop', counterexample: { seed, shadowEvents } };
      }
      if (JSON.stringify(experimentalEvents) !== JSON.stringify(['SAFETY_OR_COVERAGE_REGRESSION', 'ARTIFACT_OR_SCHEMA_INVALID'])) {
        return { held: false, detail: 'EXPERIMENTAL model was not swept via the two-hop route', counterexample: { seed, experimentalEvents } };
      }

      const finalStates = { calibrated: registry.get(calibratedRef)?.state, shadow: registry.get(shadowRef)?.state, experimental: registry.get(experimentalRef)?.state };
      if (finalStates.calibrated !== 'OFF' || finalStates.shadow !== 'OFF' || finalStates.experimental !== 'OFF') {
        return { held: false, detail: 'not every affected model ended at OFF', counterexample: { seed, finalStates } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signing/kms-profile-round-trips',
    status: 'pending',
    trials: 0,
    statement: 'A KMS/HSM-backed SigningAuthority profile (a "kms:" scheme) round-trips sign/verify against a live key management service.',
    pendingReason:
      'No live KMS/HSM endpoint exists in this environment to test a real client against — the same constraint env-provider.ts (vault:/kms: secret schemes) and filesystem-store.ts (S3 artifact profile) already state for their own production-profile gaps.',
  },
];
