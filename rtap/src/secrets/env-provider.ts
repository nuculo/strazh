import { parseSecretRef, SecretNotFoundError, UnsupportedSecretSchemeError, type ResolvedSecret, type SecretProvider } from './provider.js';

/**
 * Local profile of `SecretProvider`, resolving only the `env:` scheme against
 * `process.env`. The production profile is KMS/Vault (ARCHITECTURE.md §0) — not
 * implemented here for the same reason a real S3 client isn't in filesystem-store.ts:
 * no live KMS/Vault endpoint exists in this environment to test a real client
 * against. A `VaultSecretProvider`/`KmsSecretProvider` is a same-shaped addition,
 * dispatched by its own `vault:`/`kms:` scheme prefix — this class rejects those
 * schemes explicitly rather than silently returning nothing, so the gap is loud.
 */
export class EnvSecretProvider implements SecretProvider {
  async resolve(secretRef: string): Promise<ResolvedSecret> {
    const { scheme, locator } = parseSecretRef(secretRef);
    if (scheme !== 'env') throw new UnsupportedSecretSchemeError(secretRef);
    const value = process.env[locator];
    if (value === undefined) throw new SecretNotFoundError(secretRef);
    return { value };
  }
}
