import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { DuplicateSigningKeyError, SigningKeyStore, UnknownSigningKeyError } from '../../src/signing/key-store.js';

describe('SigningKeyStore', () => {
  it('registers a key and resolves it via get()', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    const record = store.register('key-1', 'local-ed25519', 'env:PUB_1', 'issuer-a', 'operator-1');

    expect(record.keyId).toBe('key-1');
    expect(record.revokedAt).toBeNull();
    expect(store.get('key-1')).toEqual(record);
  });

  it('get() returns null for an unregistered keyId', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    expect(store.get('never-registered')).toBeNull();
  });

  it('register() throws DuplicateSigningKeyError on a repeated keyId — minting two keys under one id is never correct', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    store.register('key-1', 'local-ed25519', 'env:PUB_1', null, null);
    expect(() => store.register('key-1', 'local-ed25519', 'env:PUB_2', null, null)).toThrow(DuplicateSigningKeyError);
  });

  it('rotation is just registering a second key — the first is untouched', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    const first = store.register('key-old', 'local-ed25519', 'env:PUB_OLD', null, null);
    store.register('key-new', 'local-ed25519', 'env:PUB_NEW', null, null);

    expect(store.get('key-old')).toEqual(first);
    expect(store.get('key-old')?.revokedAt).toBeNull();
  });

  it('revoke() throws UnknownSigningKeyError for a keyId that was never registered', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    expect(() => store.revoke('never-registered', 'reason', null)).toThrow(UnknownSigningKeyError);
  });

  it('revoke() stamps revokedAt/revokedReason/revokedBy', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    store.register('key-1', 'local-ed25519', 'env:PUB_1', null, null);
    const { record, alreadyRevoked } = store.revoke('key-1', 'compromised', 'operator-2');

    expect(alreadyRevoked).toBe(false);
    expect(record.revokedAt).not.toBeNull();
    expect(record.revokedReason).toBe('compromised');
    expect(record.revokedBy).toBe('operator-2');
  });

  it('revoke() on an already-revoked key is an idempotent no-op — the original revocation is preserved, not overwritten', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    store.register('key-1', 'local-ed25519', 'env:PUB_1', null, null);
    const first = store.revoke('key-1', 'first reason', 'operator-a');
    const second = store.revoke('key-1', 'a different reason', 'operator-b');

    expect(second.alreadyRevoked).toBe(true);
    expect(second.record.revokedReason).toBe('first reason'); // not overwritten
    expect(second.record.revokedBy).toBe('operator-a');
    expect(second.record).toEqual(first.record);
  });

  it('listRevoked() returns only revoked keys; listAll() returns every key, alphabetically', () => {
    const store = new SigningKeyStore(openInMemoryDatabase());
    store.register('key-b', 'local-ed25519', 'env:PUB_B', null, null);
    store.register('key-a', 'local-ed25519', 'env:PUB_A', null, null);
    store.revoke('key-b', 'compromised', null);

    expect(store.listAll().map((k) => k.keyId)).toEqual(['key-a', 'key-b']);
    expect(store.listRevoked().map((k) => k.keyId)).toEqual(['key-b']);
  });
});
