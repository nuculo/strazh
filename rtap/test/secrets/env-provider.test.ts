import { afterEach, describe, expect, it } from 'vitest';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { SecretNotFoundError, UnsupportedSecretSchemeError, parseSecretRef } from '../../src/secrets/provider.js';

describe('parseSecretRef', () => {
  it('splits scheme and locator', () => {
    expect(parseSecretRef('env:TARGET_API_KEY')).toEqual({ scheme: 'env', locator: 'TARGET_API_KEY' });
  });

  it('rejects a ref with no scheme separator', () => {
    expect(() => parseSecretRef('no-colon-here')).toThrow(UnsupportedSecretSchemeError);
  });

  it('rejects a ref with an empty locator', () => {
    expect(() => parseSecretRef('env:')).toThrow(UnsupportedSecretSchemeError);
  });
});

describe('EnvSecretProvider', () => {
  const key = 'RTAP_TEST_SECRET_ENV_PROVIDER';

  afterEach(() => {
    delete process.env[key];
  });

  it('resolves an existing environment variable', async () => {
    process.env[key] = 'super-secret-value';
    const provider = new EnvSecretProvider();
    const resolved = await provider.resolve(`env:${key}`);
    expect(resolved.value).toBe('super-secret-value');
  });

  it('throws SecretNotFoundError for a missing variable', async () => {
    delete process.env[key];
    const provider = new EnvSecretProvider();
    await expect(provider.resolve(`env:${key}`)).rejects.toThrow(SecretNotFoundError);
  });

  it('throws UnsupportedSecretSchemeError for a non-env scheme (e.g. vault:, kms:)', async () => {
    const provider = new EnvSecretProvider();
    await expect(provider.resolve('vault:secret/data/target-1')).rejects.toThrow(UnsupportedSecretSchemeError);
    await expect(provider.resolve('kms:arn:aws:kms:...')).rejects.toThrow(UnsupportedSecretSchemeError);
  });
});
