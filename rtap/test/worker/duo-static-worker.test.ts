import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { OutboxStore } from '../../src/events/outbox.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { DuoStaticCliAdapter } from '../../src/adapters/duo-static/run.js';
import { runDuoStaticWorkerOnce, type DuoStaticWorkerConfig, type DuoStaticWorkerDeps } from '../../src/worker/duo-static-worker.js';
import type { DuoStaticScanResult } from '../../src/adapters/duo-static/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '../fixtures/duo-static-scan-result.json'), 'utf-8')) as DuoStaticScanResult;

const OWNER = 'worker-a';
const ASSESSMENT_RUN_ID = 'run-1';

const CONFIG: DuoStaticWorkerConfig = {
  subjectId: 'operator-1',
  tenantId: 'tenant-a',
  roles: ['OPERATOR'],
  policyRevision: 'policy-v1',
  capabilityDigest: 'digest-1',
  sandboxProfileRef: 'sandbox-1',
  egressPolicyRef: 'egress-1',
  receiptDurationMs: 60_000,
  adapterVersion: '0.1.0',
  engineVersion: '0.1.0',
  concurrencyClass: 'READ_ONLY_PARALLEL',
  artifactsDir: '', // set per-test to a fresh tmpdir
  duoStatic: { path: '/repo', outputPath: 'out.json' },
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { deps: Omit<DuoStaticWorkerDeps, 'adapter'>; config: DuoStaticWorkerConfig } {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const root = mkdtempSync(path.join(tmpdir(), 'rtap-duo-static-worker-'));
  roots.push(root);
  const artifacts = new FilesystemArtifactStore(root);
  return { deps: { db, runSteps, attempts, observations, events, scheduler, authProvider, artifacts }, config: { ...CONFIG, artifactsDir: root } };
}

/** Same seam production uses to talk to a real `duo-agents` binary — injected with a fixture instead of a live process. */
function fixtureAdapter(scan: DuoStaticScanResult): DuoStaticCliAdapter {
  return new DuoStaticCliAdapter(
    async () => ({ stdout: '', stderr: '' }),
    async () => JSON.stringify(scan),
  );
}

const CLEAN_SCAN: DuoStaticScanResult = {
  id: 'scan-clean-1',
  timestamp: '2026-08-31T00:00:00.000Z',
  target: '/repo',
  duration_ms: 42,
  findings: [],
  summary: { total_files: 10, total_findings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, risk_score: 0 },
};

describe('runDuoStaticWorkerOnce: грань №17\'s duo-static production caller', () => {
  it('drains a leasable RunStep to a committed, materialized world — every finding from the real fixture, one execution attempt', async () => {
    const { deps, config } = setup();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'duo-static-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'repo-scan' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });

    const results = await runDuoStaticWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('COMMITTED');
    if (results[0]!.outcome.outcome !== 'COMMITTED') return;

    // грань №17: one scan, nine real findings, all committed under this one attempt.
    expect(results[0]!.outcome.observations).toHaveLength(fixture.findings.length);
    expect(results[0]!.outcome.observations.every((o) => !o.deduped)).toBe(true);

    const stored = deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID);
    expect(stored).toHaveLength(fixture.findings.length);
    expect(stored.every((o) => o.executionAttemptId === results[0]!.outcome.attempt.executionAttemptId)).toBe(true);
    expect(stored.every((o) => o.verdict === 'UNVERIFIED')).toBe(true);

    const outbox = new OutboxStore(deps.db);
    expect(outbox.listUndelivered('campaign-1')).toHaveLength(fixture.findings.length);

    // Real, resolvable evidence — the native-report ref is shared/deduped across every finding.
    const evidenceRefs = (stored as unknown as { evidenceRefs: { ref: string; kind: string }[] }[]).flatMap((o) => o.evidenceRefs);
    const nativeReportRefs = new Set(evidenceRefs.filter((r) => r.kind === 'native-report').map((r) => r.ref));
    expect(nativeReportRefs.size).toBe(1);
    for (const ref of nativeReportRefs) {
      await expect(deps.artifacts.get({ ref } as never)).resolves.toBeTruthy();
    }

    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('SUCCEEDED');
  });

  it('a clean scan (zero findings) still COMMITs — a real, successful attempt with nothing to report, not a failure', async () => {
    const { deps, config } = setup();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'duo-static-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'repo-scan' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });

    const results = await runDuoStaticWorkerOnce({ ...deps, adapter: fixtureAdapter(CLEAN_SCAN) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('COMMITTED');
    if (results[0]!.outcome.outcome !== 'COMMITTED') return;
    expect(results[0]!.outcome.observations).toEqual([]);
    expect(results[0]!.outcome.attempt.terminalReason).toBe('COMPLETED');
    expect(deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID)).toHaveLength(0);
    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('SUCCEEDED');
  });

  it('refuses a RunStep with no campaignId/targetId as MALFORMED_STEP and fails it durably', async () => {
    const { deps, config } = setup();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'duo-static-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'repo-scan' });

    const results = await runDuoStaticWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('MALFORMED_STEP');
    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('FAILED');
    expect(deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID)).toHaveLength(0);
  });

  it('a scan adapter failure fails the step as FAILED_BEFORE_EFFECT, no observations committed', async () => {
    const { deps, config } = setup();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'duo-static-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'repo-scan' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });
    const failingAdapter = new DuoStaticCliAdapter(async () => {
      throw new Error('ENOENT: duo-agents not found');
    });

    const results = await runDuoStaticWorkerOnce({ ...deps, adapter: failingAdapter }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    const outcome = results[0]!.outcome;
    expect(outcome.outcome).toBe('FAILED');
    if (outcome.outcome !== 'FAILED') return;
    expect(outcome.terminalReason).toBe('FAILED_BEFORE_EFFECT');
    expect(deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID)).toHaveLength(0);
  });

  it('returns an empty result list when nothing is leasable, without error', async () => {
    const { deps, config } = setup();
    const results = await runDuoStaticWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);
    expect(results).toEqual([]);
  });
});
