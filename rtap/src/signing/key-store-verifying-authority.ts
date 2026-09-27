import type { SecretProvider } from '../secrets/provider.js';
import { SigningKeyStore } from './key-store.js';
import {
  parseSignatureKeyId,
  SigningKeyUnavailableError,
  UnsupportedSignatureSchemeError,
  type SigningAuthority,
  type SigningPayload,
  type SignResult,
  type VerifyResult,
} from './authority.js';
import { LocalKeypairSigningAuthority } from './local-keypair-authority.js';

export interface KeyStoreVerifyingSigningAuthorityOptions {
  readonly secretProvider: SecretProvider;
  readonly keyStore: SigningKeyStore;
}

/**
 * грань №18: resolves the signature's own embedded `keyId` against a durable
 * `SigningKeyStore` instead of trusting whatever single key the caller
 * hardcoded — this is what makes `keyId` load-bearing instead of decorative.
 * Structurally verify-only: `sign()` unconditionally throws, since this class
 * only ever composes PUBLIC key material (via the store) — it can never hold a
 * private key, not just by convention but because nothing in its shape has
 * anywhere to put one.
 *
 * Deliberately a thin lookup layer over the existing `LocalKeypairSigningAuthority`,
 * not a reimplementation: once the keyId resolves to an unrevoked record, the
 * actual crypto (`canonicalizeArtifactForSigning()` + `node:crypto.verify`) is
 * delegated to a freshly-constructed `LocalKeypairSigningAuthority` — zero
 * duplication, zero new risk to the existing `redteam.signing/sign-then-verify-
 * roundtrips`/`redteam.signing/unsupported-signature-is-rejected-not-ignored` laws,
 * which this class never touches the internals of.
 *
 * Revocation is checked here, before delegating — not folded into
 * `LocalKeypairSigningAuthority.verify()` itself, which stays exactly what it
 * was in грань №16 (a pure crypto check with no notion of a registry at all).
 * Keeping "is this signature cryptographically valid" and "is this key still
 * trusted" as two separable steps (this class does the second, then calls into
 * something that only does the first) matches `SignatureGate`'s own documented
 * shape — "a pre-computed verification outcome, passed in as data" — more
 * literally than folding both into one opaque method would.
 */
export class KeyStoreVerifyingSigningAuthority implements SigningAuthority {
  constructor(private readonly opts: KeyStoreVerifyingSigningAuthorityOptions) {}

  async sign(_payload: SigningPayload): Promise<SignResult> {
    throw new SigningKeyUnavailableError(
      'KeyStoreVerifyingSigningAuthority is verify-only — sign() is unavailable; construct a LocalKeypairSigningAuthority directly with the operator-specified signing key to admit a model',
    );
  }

  async verify(payload: SigningPayload & { readonly signature: string }): Promise<VerifyResult> {
    const parsed = parseSignatureKeyId(payload.signature);
    if (!parsed) {
      // Includes the 'UNSIGNED' sentinel — that's an absent scheme, not a failed one.
      throw new UnsupportedSignatureSchemeError(payload.signature);
    }
    const record = this.opts.keyStore.get(parsed.keyId);
    if (!record) {
      return { valid: false, reason: `unknown keyId "${parsed.keyId}" — no such key was ever registered` };
    }
    if (record.revokedAt) {
      return {
        valid: false,
        reason: `signing key "${parsed.keyId}" was revoked at ${record.revokedAt}${record.revokedReason ? ` (${record.revokedReason})` : ''}`,
      };
    }
    const delegate = new LocalKeypairSigningAuthority({
      secretProvider: this.opts.secretProvider,
      keyId: parsed.keyId,
      publicKeySecretRef: record.publicKeySecretRef,
    });
    return delegate.verify(payload);
  }
}
