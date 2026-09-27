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
import { parsePromptfooResult, type ParseContext } from '../../src/adapters/promptfoo/parse.js';
import { materializePromptfooEvidence } from '../../src/adapters/promptfoo/evidence.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { executeLeasedStep, type StepRunner } from '../../src/execution/run-step-executor.js';
import { CampaignWorldMaterializer } from '../../src/world/materializer.js';
import { replay } from '../../src/world/replay.js';
import { fingerprint } from '../../src/world/fingerprint.js';
import type { DispatchGuardRequest } from '../../src/execution/dispatch.js';
import type { PromptfooOutputFile } from '../../src/adapters/promptfoo/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '../fixtures/promptfoo-eval-result.json'), 'utf-8')) as PromptfooOutputFile;

const OWNER = 'worker-a';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * ARCH_CLAUDE_TRANSFER.md §2.3 — the gap this closes. Until `executeLeasedStep()`
 * existed, *nothing in `src/` ever called an adapter*: the only non-test invocation
 * in the whole package was inside a law's own check. Admission, dispatch, evidence
 * materialization, fenced commit and settlement were composed exclusively inside
 * integration tests — two of them, each in its own slightly different order.
 *
 * This slice is the demonstration that the composition is now real code: a genuine
 * promptfoo result travels adapter → evidence → parse → executor → committed
 * Observation → CampaignEvent → outbox → materialized CampaignWorld, and the engine
 * composition is a closure the caller supplies rather than anything the executor
 * imports.
 */
describe('executor slice: one leased RunStep driven end to end through executeLeasedStep()', () => {
  function setup() {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);
    const scheduler = new ConcurrencyScheduler(db);
    const authProvider = new RoleBasedAuthorizationProvider();
    const root = mkdtempSync(path.join(tmpdir(), 'rtap-executor-'));
    roots.push(root);
    const artifacts = new FilesystemArtifactStore(root);
    return { db, runSteps, attempts, observations, events, scheduler, authProvider, artifacts };
  }

  function request(runStepId: string): DispatchGuardRequest {
    return {
      authorization: {
        principal: { subjectId: 'operator-1', tenantId: 'tenant-a', roles: ['OPERATOR'] },
        resourceTenantId: 'tenant-a',
        campaignId: 'campaign-1',
        assessmentRunId: 'run-1',
        runStepId,
        operationFamily: 'llm-attack',
        targetSnapshotRef: 'target-snapshot-1',
        adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' },
        declaredCapabilityDigest: 'digest-1',
        expectedCapabilityDigest: 'digest-1',
        policyRevision: 'policy-v1',
        sandboxProfileRef: 'sandbox-1',
        egressPolicyRef: 'egress-1',
        receiptDurationMs: 60_000,
      },
      concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
      attemptStart: { assessmentRunId: 'run-1', runStepId, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };
  }

  /**
   * The engine composition, as a caller-supplied closure — exactly the seam that
   * keeps `run-step-executor.ts` free of any `adapters/*` import. A real `bin/` would
   * build this once per engine and hand it to the same executor.
   */
  function promptfooStepRunner(artifacts: FilesystemArtifactStore, resultIndex: number): StepRunner {
    return async () => {
      const adapter = new PromptfooCliAdapter(
        async () => ({ stdout: '', stderr: '' }),
        async () => JSON.stringify(fixture),
      );
      const runResult = await adapter.run({ configPath: 'redteam.yaml', outputPath: 'out.json' });
      if (!runResult.ok) return { ok: false, terminalReason: 'FAILED_BEFORE_EFFECT', detail: runResult.error };

      const ctx: ParseContext = {
        assessmentRunId: 'run-1',
        targetId: 'target-1',
        nativeRunId: fixture.evalId ?? 'unknown',
        engineVersion: '0.122.0',
        adapterVersion: '0.1.0',
      };
      const native = runResult.output.results[resultIndex]!;
      const parsed = parsePromptfooResult(native, resultIndex, ctx);
      const withEvidence = await materializePromptfooEvidence(artifacts, parsed, native);

      return {
        ok: true,
        nativeResultRef: withEvidence.evidenceRefs[0]!.ref,
        observations: [
          {
            observation: withEvidence as never,
            event: eventForObservation(withEvidence as never, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: '2026-08-30T00:00:00.000Z' }),
          },
        ],
      };
    };
  }

  it('drives a real promptfoo result to a committed, materialized world — with real, resolvable evidence refs', async () => {
    const f = setup();
    const { step } = f.runSteps.enqueue('run-1', 'promptfoo-0', { probeId: 'probe-1' });
    f.runSteps.lease('run-1', { owner: OWNER, leaseDurationMs: 60_000 });

    const result = await executeLeasedStep(
      f.db, f.runSteps, f.attempts, f.observations, f.events, f.scheduler, f.authProvider,
      request(step.id), promptfooStepRunner(f.artifacts, 0), OWNER,
    );

    expect(result.outcome).toBe('COMMITTED');
    if (result.outcome !== 'COMMITTED') return;

    // Every layer the executor is responsible for, in one pass.
    expect(result.attempt.terminalReason).toBe('COMPLETED');
    expect(f.runSteps.get(step.id)?.status).toBe('SUCCEEDED');
    expect(f.scheduler.activeReservations()).toHaveLength(0);

    const stored = f.observations.listByAssessmentRun('run-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.executionAttemptId).toBe(result.attempt.executionAttemptId); // §15 criterion 2, for real

    // Audit #5's evidence really resolves — this is the first place the whole chain
    // adapter → materializeEvidence → committed Observation runs as production code.
    const evidenceRef = (stored[0]! as unknown as { evidenceRefs: { ref: string; kind: string }[] }).evidenceRefs[0]!;
    expect(evidenceRef.ref).toMatch(/^local:sha256:[0-9a-f]{64}$/);
    await expect(f.artifacts.get(evidenceRef as never)).resolves.toBeTruthy();

    // The event reached the outbox and materializes to the same world a full replay gives.
    const outbox = new OutboxStore(f.db);
    expect(outbox.listUndelivered('campaign-1')).toHaveLength(1);
    const materializer = new CampaignWorldMaterializer(f.db, f.events, outbox);
    materializer.advance('campaign-1');
    const incremental = materializer.current('campaign-1')!;
    const replayed = replay(f.events.listByCampaign('campaign-1'), 'campaign-1').world;
    expect(fingerprint(incremental)).toBe(fingerprint(replayed));
  });

  it('two steps against the same target serialize: the second is refused as back-pressure, then succeeds once the first releases', async () => {
    const f = setup();
    const { step: first } = f.runSteps.enqueue('run-1', 'promptfoo-0', { probeId: 'probe-1' });
    f.runSteps.lease('run-1', { owner: OWNER, leaseDurationMs: 60_000 });

    // Hold the TARGET_SERIAL barrier with an unrelated, still-running attempt.
    f.scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: 'holder-attempt',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });

    const refused = await executeLeasedStep(
      f.db, f.runSteps, f.attempts, f.observations, f.events, f.scheduler, f.authProvider,
      request(first.id), promptfooStepRunner(f.artifacts, 0), OWNER,
    );
    expect(refused.outcome).toBe('ADMISSION_REFUSED');
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(0);
    expect(f.runSteps.get(first.id)?.status).not.toBe('FAILED'); // still retryable

    // Release the barrier; the very same leased step now goes through.
    const held = f.scheduler.activeReservations()[0]!;
    f.scheduler.release(held.reservationId);

    const admitted = await executeLeasedStep(
      f.db, f.runSteps, f.attempts, f.observations, f.events, f.scheduler, f.authProvider,
      request(first.id), promptfooStepRunner(f.artifacts, 0), OWNER,
    );
    expect(admitted.outcome).toBe('COMMITTED');
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(1);
    expect(f.scheduler.activeReservations()).toHaveLength(0);
  });
});
