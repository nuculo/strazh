import type { SignedModelArtifact } from '../training/model-artifact.js';

/**
 * грань №16: model-signing-authority. FROZEN_INTEGRATION.md §13.7 names signing
 * authority as an open decision — this is that decision's port. Scheme-prefixed
 * dispatch (`local-ed25519:<keyId>:<sig>` today) mirrors SecretProvider's
 * `"<scheme>:<locator>"` split exactly, so a production KMS/HSM profile
 * (`kms:<keyId>:<sig>`) is a same-shaped later addition, not a replacement — an
 * unsupported scheme is rejected loudly (`UnsupportedSignatureSchemeError`), never
 * silently treated as unsigned.
 */
export interface SigningPayload {
  readonly artifact: Omit<SignedModelArtifact, 'signature'>;
}

export interface SignResult {
  readonly signature: string;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface SigningAuthority {
  sign(payload: SigningPayload): Promise<SignResult>;
  verify(payload: SigningPayload & { readonly signature: string }): Promise<VerifyResult>;
}

export class UnsupportedSignatureSchemeError extends Error {
  constructor(signature: string) {
    super(`unsupported signature scheme: ${signature}`);
    this.name = 'UnsupportedSignatureSchemeError';
  }
}

export class SigningKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyUnavailableError';
  }
}

/**
 * Signs the whole canonical envelope minus `signature` itself — not the bare
 * `sha256` alone — so metadata (`modelRef`/`issuer`/`taxonomyVersion`/`weightsRef`/
 * etc.) can't be swapped around a legitimately-signed digest. Field order is
 * explicit, not `JSON.stringify(artifact)` insertion order, so canonicalization
 * doesn't depend on how the caller happened to construct the object.
 */
export function canonicalizeArtifactForSigning(artifact: Omit<SignedModelArtifact, 'signature'>): string {
  return JSON.stringify({
    modelRef: artifact.modelRef,
    format: artifact.format,
    formatVersion: artifact.formatVersion,
    sha256: artifact.sha256,
    issuer: artifact.issuer,
    createdAt: artifact.createdAt,
    coreFingerprint: artifact.coreFingerprint,
    featureSchemaVersion: artifact.featureSchemaVersion,
    taxonomyVersion: artifact.taxonomyVersion,
    trainingDatasetRef: artifact.trainingDatasetRef,
    benchmarkRef: artifact.benchmarkRef,
    weightsRef: artifact.weightsRef,
  });
}

export interface ParsedSignature {
  readonly scheme: string;
  readonly keyId: string;
}

/**
 * грань №18: pure, scheme-agnostic — splits `"<scheme>:<keyId>:<sig>"` without
 * hardcoding `local-ed25519`'s own regex, so it already works for a future
 * `kms:<keyId>:<sig>` signature without changes. The one shared place that knows
 * how to pull a keyId out of a signature string; `LocalKeypairSigningAuthority`
 * and `KeyStoreVerifyingSigningAuthority` both call this instead of each keeping
 * their own copy. Returns `null` (never throws) on anything that isn't at least
 * `scheme:keyId:sig` shaped, including the literal `'UNSIGNED'` sentinel — the
 * caller decides whether that's an error (verify() call sites throw
 * `UnsupportedSignatureSchemeError`) or just "nothing to look up."
 */
export function parseSignatureKeyId(signature: string): ParsedSignature | null {
  const parts = signature.split(':');
  if (parts.length < 3 || parts[0] === '' || parts[1] === '') return null;
  return { scheme: parts[0]!, keyId: parts[1]! };
}
