#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db/connection.js';
import { RunStepStore } from '../runsteps/store.js';
import { ExecutionAttemptStore } from '../execution/execution-attempt-store.js';
import { ObservationStore } from '../observations/store.js';
import { CampaignEventStore } from '../events/store.js';
import { ConcurrencyScheduler } from '../execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../authz/role-based-provider.js';
import { FilesystemArtifactStore } from '../artifacts/filesystem-store.js';
import { runDuoStaticWorkerOnce, type DuoStaticWorkerConfig } from './duo-static-worker.js';
import type { Role } from '../authz/types.js';

/**
 * грань №17's duo-static production caller — same shape as `worker/cli.ts`
 * (promptfoo): `tsx src/worker/duo-static-cli.ts --db=... --assessment-run-id=... --config=...`
 * drains every currently-leasable RunStep for one assessment run through
 * `executeLeasedStep()` with a real `DuoStaticCliAdapter`.
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

const VALID_ROLES: readonly Role[] = ['VIEWER', 'OPERATOR', 'ADMIN'];
const VALID_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

function validateConfig(raw: unknown, configPath: string): DuoStaticWorkerConfig {
  if (typeof raw !== 'object' || raw === null) {
    console.error(`${configPath} did not contain a JSON object`);
    process.exit(1);
  }
  const c = raw as Record<string, unknown>;
  const requiredStrings = [
    'subjectId',
    'tenantId',
    'policyRevision',
    'capabilityDigest',
    'sandboxProfileRef',
    'egressPolicyRef',
    'adapterVersion',
    'engineVersion',
    'concurrencyClass',
    'artifactsDir',
  ] as const;
  for (const field of requiredStrings) {
    if (typeof c[field] !== 'string' || c[field] === '') {
      console.error(`${configPath}: "${field}" must be a non-empty string`);
      process.exit(1);
    }
  }
  if (!Array.isArray(c.roles) || c.roles.length === 0 || !c.roles.every((r) => VALID_ROLES.includes(r as Role))) {
    console.error(`${configPath}: "roles" must be a non-empty array of ${VALID_ROLES.join('/')}`);
    process.exit(1);
  }
  if (typeof c.receiptDurationMs !== 'number' || c.receiptDurationMs <= 0) {
    console.error(`${configPath}: "receiptDurationMs" must be a positive number`);
    process.exit(1);
  }
  const duoStatic = c.duoStatic as Record<string, unknown> | undefined;
  if (typeof duoStatic !== 'object' || duoStatic === null || typeof duoStatic.path !== 'string' || typeof duoStatic.outputPath !== 'string') {
    console.error(`${configPath}: "duoStatic.path" and "duoStatic.outputPath" are required strings`);
    process.exit(1);
  }
  if (duoStatic.minSeverity !== undefined && !VALID_SEVERITIES.includes(duoStatic.minSeverity as (typeof VALID_SEVERITIES)[number])) {
    console.error(`${configPath}: "duoStatic.minSeverity", if present, must be one of ${VALID_SEVERITIES.join('/')}`);
    process.exit(1);
  }
  if (c.sandbox !== undefined) {
    const sandbox = c.sandbox as Record<string, unknown>;
    const envOk = typeof sandbox.env === 'object' && sandbox.env !== null && Object.values(sandbox.env as Record<string, unknown>).every((v) => typeof v === 'string');
    if (typeof sandbox !== 'object' || sandbox === null || !envOk) {
      console.error(`${configPath}: "sandbox.env", if present, must be an object of string values`);
      process.exit(1);
    }
    if (sandbox.uid !== undefined && typeof sandbox.uid !== 'number') {
      console.error(`${configPath}: "sandbox.uid", if present, must be a number`);
      process.exit(1);
    }
    if (sandbox.gid !== undefined && typeof sandbox.gid !== 'number') {
      console.error(`${configPath}: "sandbox.gid", if present, must be a number`);
      process.exit(1);
    }
  }
  return raw as DuoStaticWorkerConfig;
}

const dbPath = requireFlag('db');
const assessmentRunId = requireFlag('assessment-run-id');
const configPath = requireFlag('config');
const owner = flag('owner') ?? `worker-${process.pid}`;
const leaseDurationMs = Number(flag('lease-duration-ms') ?? '60000');

const rawConfig: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
const config = validateConfig(rawConfig, configPath);

const db = openDatabase(dbPath);
const runSteps = new RunStepStore(db);
const attempts = new ExecutionAttemptStore(db, runSteps);
const observations = new ObservationStore(db);
const events = new CampaignEventStore(db);
const scheduler = new ConcurrencyScheduler(db);
const authProvider = new RoleBasedAuthorizationProvider();
const artifacts = new FilesystemArtifactStore(config.artifactsDir);

const results = await runDuoStaticWorkerOnce(
  { db, runSteps, attempts, observations, events, scheduler, authProvider, artifacts },
  config,
  assessmentRunId,
  owner,
  leaseDurationMs,
);

for (const r of results) {
  console.log(`${r.runStepId}: ${r.outcome.outcome}`);
}
console.log(`${results.length} step(s) leased and processed for ${assessmentRunId}.`);

process.exit(results.some((r) => r.outcome.outcome === 'MALFORMED_STEP') ? 1 : 0);
