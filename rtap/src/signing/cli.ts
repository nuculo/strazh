#!/usr/bin/env node
import { openDatabase } from '../db/connection.js';
import { SigningKeyStore } from './key-store.js';
import { ModelPromotionRegistry } from '../promotion/registry.js';
import { findModelsOnRevokedKeys } from '../promotion/revocation-sweep.js';

/**
 * грань №18: the operator-facing lifecycle for `signing_keys` — register a new
 * key, revoke a compromised one, list what's known. Kept as its own CLI, parallel
 * to `promotion/cli.ts`/`approval/cli.ts`/`worker/cli.ts`, rather than folded into
 * `promotion/cli.ts`: this file's classes (`SigningKeyStore`) live under
 * `src/signing/`, not `src/promotion/`, and every other domain in this repo
 * already gets its own CLI rather than sharing one.
 *
 *   tsx src/signing/cli.ts register --db=... --key-id=... --public-key=env:... [--issuer=...] [--by=...]
 *   tsx src/signing/cli.ts revoke   --db=... --key-id=... --reason="..." [--by=...]
 *   tsx src/signing/cli.ts list     --db=...
 *   tsx src/signing/cli.ts show     --db=... --key-id=...
 *
 * `revoke` prints every currently-promoted model on that key in the SAME
 * output as the revoke action itself — detection happens automatically at the
 * moment of revocation, not left to a separately-remembered `promotion/cli.ts
 * audit-revocations` run later. It never writes to `model_promotions` itself
 * (read-only via `ModelPromotionRegistry.listAll()`): revoking a key and
 * demoting the models it signed stay two separate, explicit, auditable actions
 * — see `promotion/revocation-sweep.ts`'s doc comment for why.
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function requireFlag(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`missing required --${name}=...`);
    process.exit(1);
  }
  return value;
}

const command = process.argv[2];
const dbPath = requireFlag('db');
const db = openDatabase(dbPath);
const keyStore = new SigningKeyStore(db);

if (command === 'register') {
  const keyId = requireFlag('key-id');
  const publicKeySecretRef = requireFlag('public-key');
  const issuer = flag('issuer') ?? null;
  const registeredBy = flag('by') ?? null;
  const algorithm = flag('algorithm') ?? 'local-ed25519';

  try {
    const record = keyStore.register(keyId, algorithm, publicKeySecretRef, issuer, registeredBy);
    console.log(`${record.keyId}: registered, algorithm=${record.algorithm}${record.issuer ? `, issuer=${record.issuer}` : ''}`);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (command === 'revoke') {
  const keyId = requireFlag('key-id');
  const reason = requireFlag('reason');
  const revokedBy = flag('by') ?? null;

  let result: ReturnType<SigningKeyStore['revoke']>;
  try {
    result = keyStore.revoke(keyId, reason, revokedBy);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (result.alreadyRevoked) {
    console.log(`${keyId}: already revoked at ${result.record.revokedAt} (${result.record.revokedReason ?? 'no reason recorded'}) — no change`);
  } else {
    console.log(`${keyId}: REVOKED (reason: "${reason}")`);
  }

  const registry = new ModelPromotionRegistry(db);
  const affected = findModelsOnRevokedKeys(registry.listAll(), keyStore);
  if (affected.length === 0) {
    console.log('No currently-promoted model is signed by this key.');
  } else {
    console.log(`${affected.length} currently-promoted model(s) are on this key and are UNAFFECTED until swept:`);
    for (const a of affected) {
      console.log(`  ${a.modelRef}  state=${a.state}`);
    }
    console.log('Run: tsx src/promotion/cli.ts audit-revocations --db=... --sweep');
  }
  process.exit(0);
} else if (command === 'list') {
  const keys = keyStore.listAll();
  if (keys.length === 0) {
    console.log('No signing keys registered.');
  } else {
    for (const k of keys) {
      console.log(`${k.keyId}  algorithm=${k.algorithm}${k.issuer ? `  issuer=${k.issuer}` : ''}  registeredAt=${k.registeredAt}${k.revokedAt ? `  REVOKED at ${k.revokedAt} (${k.revokedReason ?? 'no reason'})` : ''}`);
    }
  }
  process.exit(0);
} else if (command === 'show') {
  const keyId = requireFlag('key-id');
  const record = keyStore.get(keyId);
  if (!record) {
    console.error(`${keyId}: not registered`);
    process.exit(1);
  }
  console.log(`${record.keyId}: algorithm=${record.algorithm} publicKeySecretRef=${record.publicKeySecretRef} issuer=${record.issuer ?? '(none)'}`);
  console.log(`  registeredAt=${record.registeredAt} registeredBy=${record.registeredBy ?? '(unknown)'}`);
  console.log(record.revokedAt ? `  REVOKED at ${record.revokedAt} by=${record.revokedBy ?? '(unknown)'} reason="${record.revokedReason}"` : '  not revoked');
  process.exit(0);
} else {
  console.error(`usage: tsx src/signing/cli.ts <register|revoke|list|show> --db=... [--key-id=... --public-key=... [--issuer=...] | --key-id=... --reason=...]`);
  process.exit(1);
}
