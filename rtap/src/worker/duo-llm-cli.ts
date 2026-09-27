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
import { runDuoLlmWorkerOnce, type DuoLlmWorkerConfig } from './duo-llm-worker.js';
import type { Role } from '../authz/types.js';

/**
 * грань №17's duo-llm production caller — same shape as `worker/cli.ts`
 * (promptfoo) / `duo-static-cli.ts`. Every leased step drains to
 * `CAPABILITY_UNSUPPORTED` today (`duo-llm-worker.ts`'s own doc comment) — that
 * is expected, not a sign this command is broken.
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function validateConfig(raw: unknown, configPath: string): DuoLlmWorkerConfig {
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
  const duoLlm = c.duoLlm as Record<string, unknown> | undefined;
  if (typeof duoLlm !== 'object' || duoLlm === null || typeof duoLlm.outputPath !== 'string' || duoLlm.outputPath === '') {
    console.error(`${configPath}: "duoLlm.outputPath" is a required non-empty string`);
    process.exit(1);
  }
  if (duoLlm.purpose !== undefined && typeof duoLlm.purpose !== 'string') {
    console.error(`${configPath}: "duoLlm.purpose", if present, must be a string`);
    process.exit(1);
  }
  if (duoLlm.plugins !== undefined && !isStringArray(duoLlm.plugins)) {
    console.error(`${configPath}: "duoLlm.plugins", if present, must be an array of strings`);
    process.exit(1);
  }
  if (duoLlm.strategies !== undefined && !isStringArray(duoLlm.strategies)) {
    console.error(`${configPath}: "duoLlm.strategies", if present, must be an array of strings`);
    process.exit(1);
  }
  if (duoLlm.domains !== undefined && !isStringArray(duoLlm.domains)) {
    console.error(`${configPath}: "duoLlm.domains", if present, must be an array of strings`);
    process.exit(1);
  }
  if (duoLlm.attacksPerPlugin !== undefined && (typeof duoLlm.attacksPerPlugin !== 'number' || duoLlm.attacksPerPlugin <= 0)) {
    console.error(`${configPath}: "duoLlm.attacksPerPlugin", if present, must be a positive number`);
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
  return raw as DuoLlmWorkerConfig;
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

const results = await runDuoLlmWorkerOnce(
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
