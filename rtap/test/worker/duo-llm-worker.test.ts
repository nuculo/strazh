import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { DuoLlmCliAdapter } from '../../src/adapters/duo-llm/run.js';
import { runDuoLlmWorkerOnce, type DuoLlmWorkerConfig, type DuoLlmWorkerDeps } from '../../src/worker/duo-llm-worker.js';

const OWNER = 'worker-a';
const ASSESSMENT_RUN_ID = 'run-1';

const CONFIG: DuoLlmWorkerConfig = {
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
  concurrencyClass: 'TARGET_SERIAL',
  artifactsDir: '', // set per-test to a fresh tmpdir
  duoLlm: { purpose: 'internal support chatbot', attacksPerPlugin: 5, outputPath: 'out.json' },
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { deps: Omit<DuoLlmWorkerDeps, 'adapter'>; config: DuoLlmWorkerConfig } {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const root = mkdtempSync(path.join(tmpdir(), 'rtap-duo-llm-worker-'));
  roots.push(root);
  const artifacts = new FilesystemArtifactStore(root);
  return { deps: { db, runSteps, attempts, observations, events, scheduler, authProvider, artifacts }, config: { ...CONFIG, artifactsDir: root } };
}

/**
 * `DuoLlmCliAdapter.run()` checks `DECLARED_CAPABILITIES`/`REQUIRED_CAPABILITIES`
 * as its first statement, before `execFn` is ever called — no fixture can make it
 * "succeed" today (that is the whole point of the quarantine, Phase R), so unlike
 * the promptfoo/duo-static worker tests, there is no success-path test here for
 * `buildDuoLlmStepRunner()`'s observation-building branch. That branch's own
 * logic (`parseDuoLlmRedteamReport()`/`materializeDuoLlmEvidence()`) already has
 * real coverage via `test/integration/duo-llm-remediation-slice.test.ts` and the
 * adapters' own unit tests — this file covers what the worker layer actually adds:
 * capability-gate classification and identity handling.
 */
function invocationTrackingAdapter(): { adapter: DuoLlmCliAdapter; invoked: () => boolean } {
  let invoked = false;
  const adapter = new DuoLlmCliAdapter(async () => {
    invoked = true;
    return { stdout: '{}', stderr: '' };
  });
  return { adapter, invoked: () => invoked };
}

describe('runDuoLlmWorkerOnce: грань №17\'s duo-llm production caller — quarantined by design', () => {
  it('every leased step resolves CAPABILITY_UNSUPPORTED, and execFn is never invoked — the gate rejects before dispatch, every time', async () => {
    const { deps, config } = setup();
    const { adapter, invoked } = invocationTrackingAdapter();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'duo-llm-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'chatbot-redteam' }, undefined, {
      campaignId: 'campaign-1',
      targetId: 'target-1',
    });

    const results = await runDuoLlmWorkerOnce({ ...deps, adapter }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    const outcome = results[0]!.outcome;
    expect(outcome.outcome).toBe('FAILED');
    if (outcome.outcome !== 'FAILED') return;
    expect(outcome.terminalReason).toBe('CAPABILITY_UNSUPPORTED');
    expect(invoked()).toBe(false);
    expect(deps.observations.listByAssessmentRun(ASSESSMENT_RUN_ID)).toHaveLength(0);
    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('FAILED');
    // CAPABILITY_UNSUPPORTED releases the barrier immediately (settle.ts's
    // releasesOnSettlement() set) — not the retained-barrier UNKNOWN_EFFECT_OUTCOME path.
    expect(deps.scheduler.activeReservations()).toHaveLength(0);
  });

  it('refuses a RunStep with no campaignId/targetId as MALFORMED_STEP, before the capability gate is even reached', async () => {
    const { deps, config } = setup();
    const { adapter, invoked } = invocationTrackingAdapter();
    deps.runSteps.enqueue(ASSESSMENT_RUN_ID, 'duo-llm-0', { campaignId: 'campaign-1', targetId: 'target-1', probeId: 'chatbot-redteam' });

    const results = await runDuoLlmWorkerOnce({ ...deps, adapter }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.outcome).toBe('MALFORMED_STEP');
    expect(invoked()).toBe(false);
    expect(deps.runSteps.get(results[0]!.runStepId)?.status).toBe('FAILED');
  });

  it('returns an empty result list when nothing is leasable, without error', async () => {
    const { deps, config } = setup();
    const { adapter } = invocationTrackingAdapter();
    const results = await runDuoLlmWorkerOnce({ ...deps, adapter }, config, ASSESSMENT_RUN_ID, OWNER, 60_000);
    expect(results).toEqual([]);
  });
});
