import { generateKeyPairSync } from 'node:crypto';
import type { ResolvedSecret, SecretProvider } from '../../src/secrets/provider.js';
import { LocalKeypairSigningAuthority } from '../../src/signing/local-keypair-authority.js';
import { signModelArtifact } from '../../src/training/sign-model-artifact.js';
import type { SignedModelArtifact } from '../../src/training/model-artifact.js';
import type { SignatureGate } from '../../src/promotion/types.js';

/** Test-only `SecretProvider`: an in-memory map, no `process.env` mutation needed. */
class StaticSecretProvider implements SecretProvider {
  constructor(private readonly values: Readonly<Record<string, string>>) {}
  async resolve(secretRef: string): Promise<ResolvedSecret> {
    const value = this.values[secretRef];
    if (value === undefined) throw new Error(`StaticSecretProvider: no value configured for ${secretRef}`);
    return { value };
  }
}

/** Fresh, real Ed25519 keypair per call — sign+verify mode. */
export function testSigningAuthority(): LocalKeypairSigningAuthority {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secretProvider = new StaticSecretProvider({
    'test:private-key': privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'test:public-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  return new LocalKeypairSigningAuthority({
    secretProvider,
    keyId: 'test-key-1',
    privateKeySecretRef: 'test:private-key',
    publicKeySecretRef: 'test:public-key',
  });
}

/**
 * Signs `artifact` with a fresh test keypair and returns both the signed artifact
 * and a `SignatureGate` already verified against it — the one call most
 * `registry.applyEvent(modelRef, 'MODEL_ADMITTED', gate)` test call sites need.
 */
export async function signAndGate(artifact: SignedModelArtifact): Promise<{ signed: SignedModelArtifact; gate: SignatureGate }> {
  const authority = testSigningAuthority();
  const signed = await signModelArtifact(artifact, authority);
  const { signature, ...withoutSignature } = signed;
  const verifyResult = await authority.verify({ artifact: withoutSignature, signature });
  // VerifyResult.valid -> SignatureGate.verified: different field names by design
  // (verify() answers "is this signature valid", applyEvent() asks "is there a
  // verified gate for this transition") — not the same type, don't conflate them.
  const gate: SignatureGate = verifyResult.valid ? { verified: true } : { verified: false, reason: verifyResult.reason ?? 'signature does not verify' };
  return { signed, gate };
}
