#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db/connection.js';
import { EnvSecretProvider } from '../secrets/env-provider.js';
import { FilesystemArtifactStore } from '../artifacts/filesystem-store.js';
import { LocalKeypairSigningAuthority } from '../signing/local-keypair-authority.js';
import { KeyStoreVerifyingSigningAuthority } from '../signing/key-store-verifying-authority.js';
import { SigningKeyStore } from '../signing/key-store.js';
import { parseSignatureKeyId } from '../signing/authority.js';
import { ModelPromotionRegistry, type TransitionLogEntry } from './registry.js';
import { admitModel, type AdmitModelConfig } from './admit-model.js';
import { findModelsOnRevokedKeys, sweepRevokedKeyDemotions } from './revocation-sweep.js';
import { evaluatePhase16Admission, type Phase16Evidence } from './phase16-admission.js';
import { buildRegistry } from '../laws/index.js';
import type { PromotionEvent, SignatureGate } from './types.js';

/**
 * The production entrypoint `planner/cli.ts`'s own README section named as a gap:
 * `ModelPromotionRegistry.admit()`/`applyEvent()` had no caller outside tests, so
 * moving a model through OFF -> SHADOW -> EXPERIMENTAL -> CALIBRATED in a real
 * database meant a throwaway script, not a real command. Same subcommand shape
 * `approval/cli.ts` established:
 *
 *   tsx src/promotion/cli.ts admit --db=... --model-ref=... --config=... \
 *       --signing-key=env:MODEL_SIGNING_ED25519_PRIVATE --key-id=... --artifacts-dir=...
 *   tsx src/promotion/cli.ts promote --db=... --model-ref=... --event=MODEL_ADMITTED
 *   tsx src/promotion/cli.ts promote --db=... --model-ref=... --event=AB_GATES_PASSED
 *   tsx src/promotion/cli.ts promote --db=... --model-ref=... --event=OFFLINE_AND_SHADOW_GATES_PASSED
 *   tsx src/promotion/cli.ts show --db=... --model-ref=...
 *   tsx src/promotion/cli.ts history --db=... --model-ref=...
 *   tsx src/promotion/cli.ts list --db=...
 *   tsx src/promotion/cli.ts audit-revocations --db=... [--sweep]
 *   tsx src/promotion/cli.ts admission --db=... --model-ref=... [--evidence=...]
 *
 * This is deliberately just the registry's own state machine, driven for real — it
 * does not itself decide *when* a model earns promotion (that judgment, per
 * `promotion/types.ts`'s own doc comment, belongs to "RTAP policy and signed Model
 * Registry metadata," i.e. whoever runs `promote` with a specific event, informed by
 * whatever offline/A-B evidence they have), only that the transition it's told to
 * make is legal and durably recorded.
 *
 * грань №16: `admit` now signs the full artifact envelope and durably persists its
 * weights (`ArtifactStore.putWeights()`); `promote --event=MODEL_ADMITTED` verifies
 * that signature before the registry's own `applyEvent()` will grant OFF -> SHADOW —
 * the gate is enforced inside `ModelPromotionRegistry.applyEvent()` itself (see its
 * doc comment), not only here, so calling the registry directly cannot bypass it by
 * omitting the signature.
 *
 * грань №18: `promote` no longer takes `--verify-key=`/`--key-id=` at all — both
 * gated events (`MODEL_ADMITTED`, `AB_GATES_PASSED`) resolve the right key
 * automatically from the `signing_keys` registry (`src/signing/key-store.ts`) via
 * the keyId already embedded in the stored artifact's own signature, instead of
 * requiring the operator to know and supply it. `MODEL_ADMITTED` runs a full
 * cryptographic re-verify (`KeyStoreVerifyingSigningAuthority`, which also checks
 * revocation before delegating the crypto to `LocalKeypairSigningAuthority`);
 * `AB_GATES_PASSED` only checks the key's current revocation status — the stored
 * artifact's bytes cannot have changed since admission, so a second crypto
 * verify would just re-prove what admission already proved. `audit-revocations`
 * is new: lists (or, with `--sweep`, actually demotes) every currently-promoted
 * model whose signing key has since been revoked.
 *
 * `admission` reads `promotion/phase16-admission.ts`'s `evaluatePhase16Admission()`
 * against a real database and a real model — the report existed with no CLI
 * wrapper before this, same gap `evaluatePhase5Admission()` had before
 * `worker/cli.ts` existed. `--evidence=<path>` is optional and points to a JSON
 * file shaped like `Phase16Evidence`; omitted entirely, the report still runs —
 * it just honestly shows every evidence-backed and declared criterion as NOT_MET
 * and every declared-only stop condition as NOT_MONITORED, which is exactly what
 * "no evidence supplied" should look like, not an error.
 */

const KNOWN_EVENTS: readonly PromotionEvent[] = [
  'MODEL_ADMITTED',
  'OFFLINE_AND_SHADOW_GATES_PASSED',
  'AB_GATES_PASSED',
  'DRIFT_OR_QUALITY_REGRESSION',
  'SAFETY_OR_COVERAGE_REGRESSION',
  'ARTIFACT_OR_SCHEMA_INVALID',
  'INTEGRITY_OR_POLICY_FAILURE',
];

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function validateAdmitConfig(raw: unknown, configPath: string): AdmitModelConfig {
  if (typeof raw !== 'object' || raw === null) {
    fail(`${configPath}: did not contain a JSON object`);
  }
  const c = raw as Record<string, unknown>;
  const requiredStrings = ['featureSchemaVersion', 'taxonomyVersion', 'trainingDatasetRef', 'benchmarkRef', 'issuer'] as const;
  for (const field of requiredStrings) {
    if (typeof c[field] !== 'string' || c[field] === '') {
      fail(`${configPath}: "${field}" must be a non-empty string`);
    }
  }
  const w = c.weights as Record<string, unknown> | undefined;
  if (
    typeof w !== 'object' ||
    w === null ||
    w.kind !== 'linear-regression' ||
    !Array.isArray(w.weights) ||
    !w.weights.every((x) => typeof x === 'number') ||
    typeof w.bias !== 'number'
  ) {
    fail(`${configPath}: "weights" must be {kind: "linear-regression", weights: number[], bias: number}`);
  }
  return {
    featureSchemaVersion: c.featureSchemaVersion as string,
    taxonomyVersion: c.taxonomyVersion as string,
    trainingDatasetRef: c.trainingDatasetRef as string,
    benchmarkRef: c.benchmarkRef as string,
    issuer: c.issuer as string,
    weights: { weights: w.weights as number[], bias: w.bias as number },
  };
}

/**
 * `Phase16Evidence`'s two real-computed-result fields (`datasetLeakageCheck`,
 * `baselineComparison`) are validated shape-only here — this CLI does not
 * recompute `checkNoLeakage()`/`evaluateAdmissionGate()` itself, an operator runs
 * those against the model's real training artifacts and supplies the result,
 * same as every other config this CLI parses is a fact the caller asserts, not
 * something derived from nothing.
 */
function validatePhase16Evidence(raw: unknown, evidencePath: string): Phase16Evidence {
  if (typeof raw !== 'object' || raw === null) {
    fail(`${evidencePath}: did not contain a JSON object`);
  }
  const c = raw as Record<string, unknown>;

  let datasetLeakageCheck: Phase16Evidence['datasetLeakageCheck'];
  if (c.datasetLeakageCheck !== undefined) {
    const l = c.datasetLeakageCheck as Record<string, unknown>;
    if (typeof l !== 'object' || l === null || typeof l.clean !== 'boolean' || !Array.isArray(l.overlapping) || !l.overlapping.every((x) => typeof x === 'string')) {
      fail(`${evidencePath}: "datasetLeakageCheck", if present, must be {clean: boolean, overlapping: string[]}`);
    }
    datasetLeakageCheck = { clean: l.clean as boolean, overlapping: l.overlapping as string[] };
  }

  let baselineComparison: Phase16Evidence['baselineComparison'];
  if (c.baselineComparison !== undefined) {
    const b = c.baselineComparison as Record<string, unknown>;
    if (
      typeof b !== 'object' ||
      b === null ||
      typeof b.candidateName !== 'string' ||
      typeof b.beatsBestBaseline !== 'boolean' ||
      typeof b.bestBaselineName !== 'string' ||
      typeof b.bestBaselineRankCorrelation !== 'number' ||
      typeof b.candidateRankCorrelation !== 'number' ||
      typeof b.margin !== 'number' ||
      !Array.isArray(b.comparedAgainst) ||
      !Array.isArray(b.notCompared)
    ) {
      fail(
        `${evidencePath}: "baselineComparison", if present, must be an AdmissionGateResult {candidateName, beatsBestBaseline, bestBaselineName, bestBaselineRankCorrelation, candidateRankCorrelation, margin, comparedAgainst, notCompared}`,
      );
    }
    baselineComparison = {
      candidateName: b.candidateName as string,
      beatsBestBaseline: b.beatsBestBaseline as boolean,
      bestBaselineName: b.bestBaselineName as string,
      bestBaselineRankCorrelation: b.bestBaselineRankCorrelation as number,
      candidateRankCorrelation: b.candidateRankCorrelation as number,
      margin: b.margin as number,
      comparedAgainst: b.comparedAgainst as string[],
      notCompared: b.notCompared as string[],
    };
  }

  const booleanFields = [
    'utilityLabelOwnershipDocumented',
    'mandatoryTaxonomyCoverageRegressed',
    'errorAndTimeoutRatesWithinBounds',
    'sustainedAbGainAcrossHoldouts',
    'modelAndFeatureDriftWithinThresholds',
    'signedRollbackTargetAvailable',
    'unifiedReasonCodesAvailable',
    'criticalClassRegressionWithinPolicy',
    'utilityLabelsAuditable',
  ] as const;
  const booleans: Partial<Record<(typeof booleanFields)[number], boolean>> = {};
  for (const field of booleanFields) {
    if (c[field] !== undefined) {
      if (typeof c[field] !== 'boolean') {
        fail(`${evidencePath}: "${field}", if present, must be a boolean`);
      }
      booleans[field] = c[field] as boolean;
    }
  }

  let uniqueFindingsLiftPer100Calls: number | undefined;
  if (c.uniqueFindingsLiftPer100Calls !== undefined) {
    if (typeof c.uniqueFindingsLiftPer100Calls !== 'number') {
      fail(`${evidencePath}: "uniqueFindingsLiftPer100Calls", if present, must be a number`);
    }
    uniqueFindingsLiftPer100Calls = c.uniqueFindingsLiftPer100Calls;
  }

  return {
    ...(datasetLeakageCheck !== undefined ? { datasetLeakageCheck } : {}),
    ...(baselineComparison !== undefined ? { baselineComparison } : {}),
    ...(uniqueFindingsLiftPer100Calls !== undefined ? { uniqueFindingsLiftPer100Calls } : {}),
    ...booleans,
  };
}

const command = process.argv[2];
const dbPath = requireFlag('db');
const db = openDatabase(dbPath);
const registry = new ModelPromotionRegistry(db);

/**
 * `admit` and `promote --event=MODEL_ADMITTED` both need `await` (signing/verifying
 * are real async I/O) — an IIFE rather than top-level `await` so `show`/`history`/
 * `list`'s existing fully-synchronous branches stay untouched below.
 */
void (async () => {
if (command === 'admit') {
  const modelRef = requireFlag('model-ref');
  const configPath = requireFlag('config');
  const signingKeyRef = requireFlag('signing-key');
  const keyId = requireFlag('key-id');
  const artifactsDir = requireFlag('artifacts-dir');
  const rawConfig: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
  const config = validateAdmitConfig(rawConfig, configPath);

  const secretProvider = new EnvSecretProvider();
  const artifactStore = new FilesystemArtifactStore(artifactsDir);
  const signingAuthority = new LocalKeypairSigningAuthority({ secretProvider, keyId, privateKeySecretRef: signingKeyRef });

  const result = await admitModel(registry, artifactStore, signingAuthority, modelRef, config);
  if (result.artifactMismatch) {
    console.error(
      `${modelRef}: already admitted under a different artifact (sha256=${result.record.artifact.sha256}) — the registry keeps the first admission, this config's artifact was NOT admitted`,
    );
    process.exit(1);
  }
  console.log(`${modelRef}: ${result.alreadyAdmitted ? 'already admitted (no-op)' : 'admitted'}, state=${result.record.state}, sha256=${result.record.artifact.sha256}`);
  process.exit(0);
} else if (command === 'promote') {
  const modelRef = requireFlag('model-ref');
  const eventRaw = requireFlag('event');
  if (!KNOWN_EVENTS.includes(eventRaw as PromotionEvent)) {
    fail(`--event must be one of ${KNOWN_EVENTS.join(', ')}, got "${eventRaw}"`);
  }
  const event = eventRaw as PromotionEvent;

  let signature: SignatureGate | undefined;
  if (event === 'MODEL_ADMITTED' || event === 'AB_GATES_PASSED') {
    const current = registry.get(modelRef);
    if (!current) {
      fail(`${modelRef}: not admitted — cannot verify a signature for a model that was never admit()'d`);
    }
    const keyStore = new SigningKeyStore(db);

    if (event === 'MODEL_ADMITTED') {
      // Full crypto re-verify — the artifact hasn't been proven authentic yet at
      // this point in its lifecycle, so both the signature's math AND the key's
      // current revocation status need checking.
      const secretProvider = new EnvSecretProvider();
      const verifyAuthority = new KeyStoreVerifyingSigningAuthority({ secretProvider, keyStore });
      const { signature: sig, ...withoutSignature } = current.artifact;
      try {
        const verifyResult = await verifyAuthority.verify({ artifact: withoutSignature, signature: sig });
        signature = verifyResult.valid ? { verified: true } : { verified: false, reason: verifyResult.reason ?? 'signature does not verify' };
      } catch (err) {
        // Includes UnsupportedSignatureSchemeError on the 'UNSIGNED' sentinel or
        // an unrecognized scheme — an unsigned artifact fails the gate the same
        // as an invalid one, just with a more specific reason surfaced.
        signature = { verified: false, reason: err instanceof Error ? err.message : String(err) };
      }
    } else {
      // AB_GATES_PASSED: грань №18 — the stored artifact's bytes cannot have
      // changed since MODEL_ADMITTED already proved the crypto once
      // (ModelPromotionRegistry.admit() has no update path), so re-running
      // SigningAuthority.verify() here would just re-prove the same unchanging
      // fact. The only thing that CAN have changed is the key's revocation
      // status — a cheap registry lookup, no SecretProvider round-trip, no
      // crypto.verify() call.
      const parsed = parseSignatureKeyId(current.artifact.signature);
      if (!parsed) {
        signature = { verified: false, reason: `signature "${current.artifact.signature}" is not a well-formed, resolvable signature` };
      } else {
        const key = keyStore.get(parsed.keyId);
        if (!key) {
          signature = { verified: false, reason: `unknown keyId "${parsed.keyId}" — no such key was ever registered` };
        } else if (key.revokedAt) {
          signature = { verified: false, reason: `signing key "${parsed.keyId}" was revoked at ${key.revokedAt}${key.revokedReason ? ` (${key.revokedReason})` : ''}` };
        } else {
          signature = { verified: true };
        }
      }
    }
  }

  let transition: TransitionLogEntry;
  try {
    transition = registry.applyEvent(modelRef, event, signature);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (!transition.allowed) {
    console.error(`${modelRef}: ${event} refused — ${transition.reason}`);
    process.exit(1);
  }
  console.log(`${modelRef}: ${transition.from} -> ${transition.to} (${event})`);
  process.exit(0);
} else if (command === 'audit-revocations') {
  const sweep = process.argv.includes('--sweep');
  const keyStore = new SigningKeyStore(db);

  if (!sweep) {
    const affected = findModelsOnRevokedKeys(registry.listAll(), keyStore);
    if (affected.length === 0) {
      console.log('No promoted model is currently signed by a revoked key.');
    } else {
      for (const a of affected) {
        console.log(`${a.modelRef}  state=${a.state}  keyId=${a.keyId}  revokedAt=${a.revokedAt}${a.revokedReason ? `  reason="${a.revokedReason}"` : ''}`);
      }
      console.log(`${affected.length} model(s) affected. Re-run with --sweep to demote them.`);
    }
  } else {
    const entries = sweepRevokedKeyDemotions(registry, keyStore);
    if (entries.length === 0) {
      console.log('No promoted model was on a revoked key — nothing to sweep.');
    } else {
      for (const e of entries) {
        console.log(`${e.modelRef}: ${e.from} -> ${e.to} (${e.event})`);
      }
    }
  }
  process.exit(0);
} else if (command === 'admission') {
  const modelRef = requireFlag('model-ref');
  const evidencePath = flag('evidence');
  const evidence = evidencePath ? validatePhase16Evidence(JSON.parse(readFileSync(evidencePath, 'utf-8')), evidencePath) : {};

  const report = await evaluatePhase16Admission(buildRegistry(), registry, modelRef, evidence);
  console.log(`${report.modelRef}:`);
  for (const c of report.criteria) {
    console.log(`  [${c.tier}] ${c.id} ${c.status}  ${c.statement}`);
    console.log(`    ${c.detail}`);
  }
  console.log('stop conditions:');
  for (const s of report.stopConditions) {
    console.log(`  ${s.id} ${s.status}  ${s.statement}`);
    console.log(`    ${s.detail}`);
  }
  console.log(`shadowAdmissible=${report.shadowAdmissible} experimentalAdmissible=${report.experimentalAdmissible} calibratedAdmissible=${report.calibratedAdmissible}`);
  process.exit(0);
} else if (command === 'show') {
  const modelRef = requireFlag('model-ref');
  const record = registry.get(modelRef);
  if (!record) {
    console.error(`${modelRef}: not admitted`);
    process.exit(1);
  }
  console.log(`${modelRef}: state=${record.state} updatedAt=${record.updatedAt}`);
  console.log(`  featureSchemaVersion=${record.artifact.featureSchemaVersion} taxonomyVersion=${record.artifact.taxonomyVersion} sha256=${record.artifact.sha256} signature=${record.artifact.signature}`);
  process.exit(0);
} else if (command === 'list') {
  const records = registry.listAll();
  if (records.length === 0) {
    console.log('No models admitted.');
  } else {
    for (const r of records) {
      console.log(`${r.modelRef}  state=${r.state}  featureSchemaVersion=${r.artifact.featureSchemaVersion}  taxonomyVersion=${r.artifact.taxonomyVersion}  updatedAt=${r.updatedAt}`);
    }
  }
  process.exit(0);
} else if (command === 'history') {
  const modelRef = requireFlag('model-ref');
  const entries = registry.history(modelRef);
  if (entries.length === 0) {
    console.log(`${modelRef}: no transition history`);
  } else {
    for (const e of entries) {
      console.log(`${e.at}  ${e.event}  ${e.from} -> ${e.to}  allowed=${e.allowed}  ${e.reason}`);
    }
  }
  process.exit(0);
} else {
  console.error(
    `usage: tsx src/promotion/cli.ts <admit|promote|show|history|list|audit-revocations|admission> --db=... [--model-ref=... --config=... --signing-key=... --key-id=... --artifacts-dir=... | --model-ref=... --event=... | --sweep | --model-ref=... --evidence=...]`,
  );
  process.exit(1);
}
})();
