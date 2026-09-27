import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { SigningKeyStore } from '../../src/signing/key-store.js';
import { KeyStoreVerifyingSigningAuthority } from '../../src/signing/key-store-verifying-authority.js';
import { SigningKeyUnavailableError } from '../../src/signing/authority.js';
import { LocalKeypairSigningAuthority } from '../../src/signing/local-keypair-authority.js';
import { packageLinearModelArtifact } from '../../src/training/model-artifact.js';
import { signModelArtifact } from '../../src/training/sign-model-artifact.js';
import { makeLinearRegressionBaseline } from '../../src/training/baselines/linear-regression-baseline.js';
import type { ResolvedSecret, SecretProvider } from '../../src/secrets/provider.js';

class StaticSecretProvider implements SecretProvider {
  constructor(private readonly values: Readonly<Record<string, string>>) {}
  async resolve(secretRef: string): Promise<ResolvedSecret> {
    const value = this.values[secretRef];
    if (value === undefined) throw new Error(`no value for ${secretRef}`);
    return { value };
  }
}

function testArtifact() {
  const model = makeLinearRegressionBaseline({ epochs: 5 }).fit([]);
  return packageLinearModelArtifact(model, {
    modelRef: 'model-1',
    featureSchemaVersion: '1.0.0',
    taxonomyVersion: 'taxonomy-v1',
    trainingDatasetRef: 'ds-1',
    benchmarkRef: 'bench-1',
    issuer: 'test',
  });
}

describe('KeyStoreVerifyingSigningAuthority', () => {
  it('sign() always throws SigningKeyUnavailableError — this authority structurally never holds a private key', async () => {
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    const authority = new KeyStoreVerifyingSigningAuthority({ secretProvider: new StaticSecretProvider({}), keyStore });
    await expect(authority.sign({ artifact: { ...testArtifact() } })).rejects.toThrow(SigningKeyUnavailableError);
  });

  it('verify() resolves the key from the store and delegates real crypto verification', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secretProvider = new StaticSecretProvider({
      priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    keyStore.register('key-1', 'local-ed25519', 'pub', null, null);

    const signAuthority = new LocalKeypairSigningAuthority({ secretProvider, keyId: 'key-1', privateKeySecretRef: 'priv' });
    const signed = await signModelArtifact(testArtifact(), signAuthority);

    const verifyAuthority = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });
    const { signature, ...withoutSignature } = signed;
    const result = await verifyAuthority.verify({ artifact: withoutSignature, signature });

    expect(result.valid).toBe(true);
  });

  it('verify() refuses a signature under a keyId that was never registered', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const secretProvider = new StaticSecretProvider({ priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const signAuthority = new LocalKeypairSigningAuthority({ secretProvider, keyId: 'unregistered-key', privateKeySecretRef: 'priv' });
    const signed = await signModelArtifact(testArtifact(), signAuthority);

    const emptyStore = new SigningKeyStore(openInMemoryDatabase());
    const verifyAuthority = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore: emptyStore });
    const { signature, ...withoutSignature } = signed;
    const result = await verifyAuthority.verify({ artifact: withoutSignature, signature });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unknown keyId');
  });
});
