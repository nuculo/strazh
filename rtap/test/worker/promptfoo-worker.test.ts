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
import { PromptfooCliAdapter } from '../../src/adapters/promptfoo/run.js';
import { runPromptfooWorkerOnce, type PromptfooWorkerConfig, type PromptfooWorkerDeps } from '../../src/worker/promptfoo-worker.js';
import type { PromptfooOutputFile } from '../../src/adapters/promptfoo/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '../fixtures/promptfoo-eval-result.json'), 'utf-8')) as PromptfooOutputFile;

const OWNER = 'worker-a';
const ASSESSMENT_RUN_ID = 'run-1';

const CONFIG: PromptfooWorkerConfig = {
  subjectId: 'operator-1',
  tenantId: 'tenant-a',
  roles: ['OPERATOR'],
  policyRevision: 'policy-v1',
  capabilityDigest: 'digest-1',
  sandboxProfileRef: 'sandbox-1',
  egressPolicyRef: 'egress-1',
  receiptDurationMs: 60_000,
  adapterVersion: '0.1.0',
  engineVersion: '0.122.0',
  concurrencyClass: 'TARGET_SERIAL',
  artifactsDir: '', // set per-test to a fresh tmpdir
  promptfoo: { configPath: 'redteam.yaml', outputPath: 'out.json' },
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { deps: Omit<PromptfooWorkerDeps, 'adapter'>; config: PromptfooWorkerConfig } {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const root = mkdtempSync(path.join(tmpdir(), 'rtap-worker-'));
  roots.push(root);
  const artifacts = new FilesystemArtifactStore(root);
  return { deps: { db, runSteps, attempts, observations, events, scheduler, authProvider, artifacts }, config: { ...CONFIG, artifactsDir: root } };
}

/** The real PromptfooCliAdapter, injected with a fixture instead of a live process — same seam production uses to talk to a real `promptfoo` binary. */
function fixtureAdapter(output: PromptfooOutputFile): PromptfooCliAdapter {
  return new PromptfooCliAdapter(
    async () => ({ stdout: '', stderr: '' }),
    async () => JSON.stringify(output),
  );
}

/** Same seam, one output per successive `run()` call — for a test that leases and processes more than one step per `runPromptfooWorkerOnce()` call and needs each to produce a distinct native result. */
function sequencedFixtureAdapter(outputs: readonly PromptfooOutputFile[]): PromptfooCliAdapter {
  let i = 0;
  return new PromptfooCliAdapter(
    async () => ({ stdout: '', stderr: '' }),
    async () => JSON.stringify(outputs[Math.min(i++, outputs.length - 1)]),
  );
}

describe('runPromptfooWorkerOnce: the production caller for §15 criterion 12', () => {
  it('drains a leasable RunStep with identity to a committed, materialized world', async () => {
    const { deps, config } = setup();
    const singleResult: PromptfooOutputFile = { evalId: fixture.evalId, results: [fixture.results[0]!] };
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'probe-1' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });

    const results = await runPromptfooWorkerOnce({ ...deps, adapter: fixtureAdapter(singleResult) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('COMMITTED');
    if (results[0]!.outcome.outcome !== 'COMMITTED') return;

    const stored = deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.executionAttemptId).toBe(results[0]!.outcome.attempt.executionAttemptId);

    const outbox = new OutboxStore(deps.db);
    expect(outbox.listUndelivered('campaign-1')).toHaveLength(1);

    // The RunStep itself is durably SUCCEEDED, not just the in-memory result.
    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('SUCCEEDED');
  });

  it('drains every leasable step in one call, not just the first', async () => {
    const { deps, config } = setup();
    // Two distinct native results, one per step — a real second promptfoo run would
    // never echo the exact same result id back for a different target.
    const firstOutput: PromptfooOutputFile = { evalId: fixture.evalId, results: [fixture.results[0]!] };
    const secondOutput: PromptfooOutputFile = { evalId: fixture.evalId, results: [fixture.results[1]!] };
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'probe-1' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-1', { campaignId: 'campaign-1', targetId: 'target-2', probeId: 'probe-2' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-2',
    });

    const results = await runPromptfooWorkerOnce(
      { ...deps, adapter: sequencedFixtureAdapter([firstOutput, secondOutput]) },
      config,
      ASSESSMENT_RUN_ID,
      OWNER,
      60_000,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome.outcome === 'COMMITTED')).toBe(true);
    expect(deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID)).toHaveLength(2);
  });

  it('refuses a RunStep with no campaignId/targetId as MALFORMED_STEP and fails it durably, rather than crashing or silently skipping it', async () => {
    const { deps, config } = setup();
    // No `identity` argument, so RunStep.campaignId/targetId (the columns the worker
    // actually checks) stay NULL, same as every pre-ARCH_CLAUDE_TRANSFER-§2.5 caller —
    // even though the payload itself still carries values, they were never persisted
    // as queryable identity.
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'probe-1' });

    const results = await runPromptfooWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('MALFORMED_STEP');
    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('FAILED');
    expect(deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID)).toHaveLength(0);
  });

  it('refuses a promptfoo output with anything other than exactly one result, as NORMALIZATION_FAILED', async () => {
    const { deps, config } = setup();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'probe-1' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });

    // The real fixture carries four results — a batch, not the single-probe shape
    // this worker requires.
    const results = await runPromptfooWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    const outcome = results[0]!.outcome;
    expect(outcome.outcome).toBe('FAILED');
    if (outcome.outcome !== 'FAILED') return;
    expect(outcome.terminalReason).toBe('NORMALIZATION_FAILED');
  });

  it('returns an empty result list when nothing is leasable, without error', async () => {
    const { deps, config } = setup();
    const results = await runPromptfooWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);
    expect(results).toEqual([]);
  });

  it('грань №19: a step whose concurrency would conflict with an already-held reservation is left unleased, not fenced for nothing', async () => {
    const { deps, config } = setup();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'probe-1' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });
    // config.concurrencyClass is TARGET_SERIAL — an external holder already occupies target-1's barrier.
    deps.scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: 'holder',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });

    const results = await runPromptfooWorkerOnce({ ...deps, adapter: fixtureAdapter(fixture) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toEqual([]); // the blocked step was never leased, so nothing ran
    const steps = deps.runSteps.listByAssessmentRun(ASSESSMENT_RUN_ID);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('PENDING');
    expect(steps[0]!.leaseGeneration).toBe(0); // the fix: no wasted fencing bump on a foreseeable refusal
  });

  it('грань №19: a concurrency-blocked step does not prevent a different, unblocked step from being processed in the same drain pass', async () => {
    const { deps, config } = setup();
    const okOutput: PromptfooOutputFile = { evalId: fixture.evalId, results: [fixture.results[1]!] };

    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'probe-1' }, new Date(0), {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'promptfoo-1', { campaignId: 'campaign-1', targetId: 'target-2', probeId: 'probe-2' }, new Date(1000), {
      campaignId: 'campaign-1',
      targetId: 'target-2',
    });
    deps.scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: 'holder',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });

    const results = await runPromptfooWorkerOnce({ ...deps, adapter: sequencedFixtureAdapter([okOutput]) }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('COMMITTED');
    const steps = deps.runSteps.listByAssessmentRun(ASSESSMENT_RUN_ID);
    const blockedStep = steps.find((s) => s.targetId === 'target-1')!;
    expect(blockedStep.status).toBe('PENDING');
    expect(blockedStep.leaseGeneration).toBe(0);
  });
});
