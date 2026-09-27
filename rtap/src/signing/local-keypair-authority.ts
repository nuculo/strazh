import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { SecretProvider } from '../secrets/provider.js';
import {
  canonicalizeArtifactForSigning,
  SigningKeyUnavailableError,
  UnsupportedSignatureSchemeError,
  type SigningAuthority,
  type SigningPayload,
  type SignResult,
  type VerifyResult,
} from './authority.js';

const SIGNATURE_PATTERN = /^local-ed25519:([^:]+):([A-Za-z0-9+/=]+)$/;

export interface LocalKeypairSigningAuthorityOptions {
  readonly secretProvider: SecretProvider;
  readonly keyId: string;
  /** PEM PKCS8. Presence enables sign(); absence makes this a verify-only authority. */
  readonly privateKeySecretRef?: string;
  /** PEM SPKI. If absent, verify() derives the public key from the private key. */
  readonly publicKeySecretRef?: string;
}

/**
 * Local profile of `SigningAuthority` — the production profile is a KMS/HSM-backed
 * `kms:` scheme, not implemented here for the same reason `filesystem-store.ts`'s
 * S3 gap and `env-provider.ts`'s KMS/Vault gap aren't: no live endpoint exists in
 * this environment to test a real client against. Real, genuinely cryptographic
 * Ed25519 sign/verify (`node:crypto`), not mocked — the same "local-but-real, not
 * fake-but-real-looking" discipline `FilesystemArtifactStore`/`EnvSecretProvider`
 * already follow. `node:crypto.sign`/`.verify` are themselves synchronous; wrapping
 * them in `async` fulfills `SigningAuthority`'s port contract the same way
 * `EnvSecretProvider.resolve()` already wraps a trivially-sync `process.env` read.
 *
 * Sign-mode/verify-only-mode split: a caller holding only `publicKeySecretRef`
 * cannot forge a signature — the process that gates promotion never needs to hold
 * forging capability.
 */
export class LocalKeypairSigningAuthority implements SigningAuthority {
  constructor(private readonly opts: LocalKeypairSigningAuthorityOptions) {
    if (!opts.privateKeySecretRef && !opts.publicKeySecretRef) {
      throw new SigningKeyUnavailableError('neither privateKeySecretRef nor publicKeySecretRef configured');
    }
  }

  async sign(payload: SigningPayload): Promise<SignResult> {
    if (!this.opts.privateKeySecretRef) {
      throw new SigningKeyUnavailableError('verify-only authority — sign() is unavailable');
    }
    const { value: pem } = await this.opts.secretProvider.resolve(this.opts.privateKeySecretRef);
    const sig = cryptoSign(null, Buffer.from(canonicalizeArtifactForSigning(payload.artifact)), createPrivateKey(pem));
    return { signature: `local-ed25519:${this.opts.keyId}:${sig.toString('base64')}` };
  }

  async verify(payload: SigningPayload & { readonly signature: string }): Promise<VerifyResult> {
    const match = SIGNATURE_PATTERN.exec(payload.signature);
    if (!match) {
      // Includes the 'UNSIGNED' sentinel — that's an absent scheme, not a failed one.
      throw new UnsupportedSignatureSchemeError(payload.signature);
    }
    const publicKeyRef = this.opts.publicKeySecretRef ?? this.opts.privateKeySecretRef;
    if (!publicKeyRef) {
      throw new SigningKeyUnavailableError('no key material configured for verify()');
    }
    const { value: pem } = await this.opts.secretProvider.resolve(publicKeyRef);
    const key = this.opts.publicKeySecretRef ? createPublicKey(pem) : createPublicKey(createPrivateKey(pem));
    const ok = cryptoVerify(null, Buffer.from(canonicalizeArtifactForSigning(payload.artifact)), key, Buffer.from(match[2]!, 'base64'));
    return ok ? { valid: true } : { valid: false, reason: 'signature does not verify against the configured public key' };
  }
}
