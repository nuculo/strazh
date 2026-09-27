import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { SigningKeyStore } from '../../src/signing/key-store.js';
import { findModelsOnRevokedKeys, sweepRevokedKeyDemotions } from '../../src/promotion/revocation-sweep.js';
import { ModelPromotionRegistry, type PromotionRecord } from '../../src/promotion/registry.js';

function recordWithSignature(modelRef: string, state: PromotionRecord['state'], signature: string): PromotionRecord {
  return {
    modelRef,
    state,
    updatedAt: '2026-09-01T00:00:00.000Z',
    artifact: { signature } as never, // only .signature is read by findModelsOnRevokedKeys()
  };
}

describe('findModelsOnRevokedKeys()', () => {
  it('finds nothing when the key store has no revoked keys', () => {
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    keyStore.register('key-1', 'local-ed25519', 'env:PUB', null, null);
    const records = [recordWithSignature('m1', 'CALIBRATED', 'local-ed25519:key-1:sig')];

    expect(findModelsOnRevokedKeys(records, keyStore)).toEqual([]);
  });

  it('skips OFF models even if their key is revoked — authorityFor(OFF) already grants nothing', () => {
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    keyStore.register('key-1', 'local-ed25519', 'env:PUB', null, null);
    keyStore.revoke('key-1', 'compromised', null);
    const records = [recordWithSignature('m1', 'OFF', 'local-ed25519:key-1:sig')];

    expect(findModelsOnRevokedKeys(records, keyStore)).toEqual([]);
  });

  it('skips a record whose signature does not parse (e.g. the UNSIGNED sentinel) — not the question this function answers', () => {
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    const records = [recordWithSignature('m1', 'CALIBRATED', 'UNSIGNED')];

    expect(findModelsOnRevokedKeys(records, keyStore)).toEqual([]);
  });

  it('finds a promoted model whose key is revoked, for every live state', () => {
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    keyStore.register('key-1', 'local-ed25519', 'env:PUB', null, null);
    keyStore.revoke('key-1', 'compromised', null);
    const records = [
      recordWithSignature('m-shadow', 'SHADOW', 'local-ed25519:key-1:sig'),
      recordWithSignature('m-experimental', 'EXPERIMENTAL', 'local-ed25519:key-1:sig'),
      recordWithSignature('m-calibrated', 'CALIBRATED', 'local-ed25519:key-1:sig'),
    ];

    const affected = findModelsOnRevokedKeys(records, keyStore);
    expect(affected.map((a) => a.modelRef).sort()).toEqual(['m-calibrated', 'm-experimental', 'm-shadow']);
    expect(affected.every((a) => a.keyId === 'key-1' && a.revokedReason === 'compromised')).toBe(true);
  });
});

describe('sweepRevokedKeyDemotions()', () => {
  it('is a no-op when nothing is affected', () => {
    const keyStore = new SigningKeyStore(openInMemoryDatabase());
    // No models admitted at all — registry.listAll() is empty.
    const registry = new ModelPromotionRegistry(openInMemoryDatabase());
    expect(sweepRevokedKeyDemotions(registry, keyStore)).toEqual([]);
  });
});
