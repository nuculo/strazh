import type { DatabaseSync } from 'node:sqlite';

/**
 * грань №18: durable registry of every signing key `keyId` this system has ever
 * trusted. One row per key, never per issuer — the signature string itself
 * (`local-ed25519:<keyId>:<sig>`) only ever carries a keyId, not an issuer;
 * `issuer` here is descriptive metadata on the record, not part of how a key is
 * looked up. Rotation needs no state transition at all: registering a new keyId
 * IS the rotation — an old key is never marked "superseded," it simply keeps
 * existing, still resolvable via `get()`, still trusted, until explicitly
 * revoked. Only revocation changes anything a verifier can observe.
 */
export interface SigningKeyRecord {
  readonly keyId: string;
  readonly algorithm: string;
  readonly publicKeySecretRef: string;
  readonly issuer: string | null;
  readonly registeredAt: string;
  readonly registeredBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly revokedBy: string | null;
}

export class DuplicateSigningKeyError extends Error {
  constructor(keyId: string) {
    super(`signing key "${keyId}" is already registered — minting two different keys under the same id is never correct, register a new keyId instead`);
    this.name = 'DuplicateSigningKeyError';
  }
}

export class UnknownSigningKeyError extends Error {
  constructor(keyId: string) {
    super(`no signing key registered under "${keyId}"`);
    this.name = 'UnknownSigningKeyError';
  }
}

interface SigningKeyRow {
  key_id: string;
  algorithm: string;
  public_key_secret_ref: string;
  issuer: string | null;
  registered_at: string;
  registered_by: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  revoked_by: string | null;
}

function fromRow(row: SigningKeyRow): SigningKeyRecord {
  return {
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicKeySecretRef: row.public_key_secret_ref,
    issuer: row.issuer,
    registeredAt: row.registered_at,
    registeredBy: row.registered_by,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    revokedBy: row.revoked_by,
  };
}

export class SigningKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Throws `DuplicateSigningKeyError` on an existing keyId — a collision is an operator mistake, not a legitimate retry (unlike `ModelPromotionRegistry.admit()`'s deliberate idempotency by modelRef, minting two different keys under one id is never correct). */
  register(keyId: string, algorithm: string, publicKeySecretRef: string, issuer: string | null, registeredBy: string | null, now = new Date()): SigningKeyRecord {
    if (this.get(keyId)) throw new DuplicateSigningKeyError(keyId);
    const record: SigningKeyRecord = {
      keyId,
      algorithm,
      publicKeySecretRef,
      issuer,
      registeredAt: now.toISOString(),
      registeredBy,
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
    };
    this.db
      .prepare(
        `INSERT INTO signing_keys (key_id, algorithm, public_key_secret_ref, issuer, registered_at, registered_by, revoked_at, revoked_reason, revoked_by)
         VALUES (@keyId, @algorithm, @publicKeySecretRef, @issuer, @registeredAt, @registeredBy, NULL, NULL, NULL)`,
      )
      .run({ keyId, algorithm, publicKeySecretRef, issuer, registeredAt: record.registeredAt, registeredBy });
    return record;
  }

  get(keyId: string): SigningKeyRecord | null {
    const row = this.db.prepare(`SELECT * FROM signing_keys WHERE key_id = @keyId`).get({ keyId }) as SigningKeyRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Idempotent: revoking an already-revoked key is a safe no-op that returns the
   * existing record plus `alreadyRevoked: true` — not a silent double-write (the
   * original `revokedAt`/`revokedReason` are preserved, never overwritten), not a
   * throw. No `unrevoke()` — if a revocation is later judged mistaken, register a
   * new keyId rather than resurrecting the old one; the audit trail stays honest
   * about the fact that this specific key was, at some point, distrusted.
   */
  revoke(keyId: string, reason: string, revokedBy: string | null, now = new Date()): { readonly record: SigningKeyRecord; readonly alreadyRevoked: boolean } {
    const existing = this.get(keyId);
    if (!existing) throw new UnknownSigningKeyError(keyId);
    if (existing.revokedAt) return { record: existing, alreadyRevoked: true };
    this.db
      .prepare(`UPDATE signing_keys SET revoked_at = @revokedAt, revoked_reason = @reason, revoked_by = @revokedBy WHERE key_id = @keyId`)
      .run({ keyId, revokedAt: now.toISOString(), reason, revokedBy });
    return { record: this.get(keyId)!, alreadyRevoked: false };
  }

  listRevoked(): SigningKeyRecord[] {
    const rows = this.db.prepare(`SELECT * FROM signing_keys WHERE revoked_at IS NOT NULL ORDER BY revoked_at ASC`).all() as unknown as SigningKeyRow[];
    return rows.map(fromRow);
  }

  listAll(): SigningKeyRecord[] {
    const rows = this.db.prepare(`SELECT * FROM signing_keys ORDER BY key_id ASC`).all() as unknown as SigningKeyRow[];
    return rows.map(fromRow);
  }
}
