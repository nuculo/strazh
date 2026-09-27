import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import { executeLeasedStep, leaseWithConcurrencyPrecheck, type StepRunner } from '../../src/execution/run-step-executor.js';
import type { ApprovalGate, DispatchGuardRequest } from '../../src/execution/dispatch.js';
import { PendingApprovalStore } from '../../src/execution/approval-store.js';
import type { ObservationRecord } from '../../src/observations/store.js';
import type { CampaignEventInput } from '../../src/events/store.js';

const OWNER = 'worker-a';
const LEASE_MS = 60_000;

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1' });
  runSteps.lease('run-1', { owner: OWNER, leaseDurationMs: LEASE_MS });
  return { db, runSteps, attempts, observations, events, scheduler, authProvider, step };
}

function request(runStepId: string, role: 'OPERATOR' | 'VIEWER' = 'OPERATOR'): DispatchGuardRequest {
  return {
    authorization: {
      principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: [role] },
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

function validObservation(id: string): ObservationRecord {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1',
    assessmentRunId: 'run-1',
    verdict: 'VULNERABLE',
    evidenceRefs: [],
    provenance: {
      engineId: 'promptfoo',
      engineVersion: '0.122.0',
      adapterVersion: '0.1.0',
      schemaVersion: '1.0.0',
      nativeRunId: 'native-run-1',
      nativeResultId: id,
      graderKind: 'llm-judge',
    },
  } as unknown as ObservationRecord;
}

function validEvent(id: string): CampaignEventInput {
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${id}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    occurredAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [id],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId: 'target-1', probeId: 'probe-1', verdict: 'VULNERABLE' },
  } as unknown as CampaignEventInput;
}

const succeedingRunner: StepRunner = async () => ({
  ok: true,
  nativeResultRef: 'local:sha256:' + 'a'.repeat(64),
  observations: [{ observation: validObservation('obs-1'), event: validEvent('obs-1') }],
});

async function run(fixture: ReturnType<typeof setup>, runner: StepRunner, role: 'OPERATOR' | 'VIEWER' = 'OPERATOR') {
  const { db, runSteps, attempts, observations, events, scheduler, authProvider, step } = fixture;
  return executeLeasedStep(db, runSteps, attempts, observations, events, scheduler, authProvider, request(step.id, role), runner, OWNER);
}

describe('executeLeasedStep — the single execution semantics', () => {
  it('runs the whole path: admit, dispatch, commit, settle, release, complete', async () => {
    const f = setup();
    const result = await run(f, succeedingRunner);

    expect(result.outcome).toBe('COMMITTED');
    if (result.outcome !== 'COMMITTED') return;
    expect(result.attempt.terminalReason).toBe('COMPLETED');
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(1);
    expect(f.events.listByCampaign('campaign-1')).toHaveLength(1);
    expect(f.runSteps.get(f.step.id)?.status).toBe('SUCCEEDED');
    expect(f.scheduler.activeReservations()).toHaveLength(0); // settleAttempt released it
  });

  /**
   * The guarantee that did not exist anywhere before this module: whatever the runner
   * does, the attempt is settled and no barrier is stranded. Previously the two
   * de-facto orchestrators lived in integration tests and neither covered a runner
   * that fails after admission.
   */
  it('a runner that returns a typed failure settles the attempt and releases the barrier', async () => {
    const f = setup();
    const result = await run(f, async () => ({ ok: false, terminalReason: 'FAILED_BEFORE_EFFECT', detail: 'ECONNREFUSED' }));

    expect(result.outcome).toBe('FAILED');
    if (result.outcome !== 'FAILED') return;
    expect(result.terminalReason).toBe('FAILED_BEFORE_EFFECT');
    expect(result.attempt.terminalReason).toBe('FAILED_BEFORE_EFFECT');
    expect(f.scheduler.activeReservations()).toHaveLength(0);
    expect(f.runSteps.get(f.step.id)?.status).toBe('FAILED');
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(0);
  });

  it('a runner that throws settles UNKNOWN_EFFECT_OUTCOME and RETAINS the barrier — an unclassified crash is not proof the effect never happened', async () => {
    const f = setup();
    const result = await run(f, async () => {
      throw new Error('adapter segfaulted');
    });

    expect(result.outcome).toBe('FAILED');
    if (result.outcome !== 'FAILED') return;
    expect(result.terminalReason).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(result.detail).toContain('segfaulted');
    // Deliberately still held: RUNBOOK.md Part A resolves it, then Part B releases.
    expect(f.scheduler.activeReservations()).toHaveLength(1);
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(0);
  });

  it('an unauthorized principal is rejected before any effect, and the step is failed', async () => {
    const f = setup();
    const result = await run(f, succeedingRunner, 'VIEWER');

    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.attempt.terminalReason).toBe('AUTHORIZATION_DENIED');
    expect(f.scheduler.activeReservations()).toHaveLength(0); // never reserved
    expect(f.runSteps.get(f.step.id)?.status).toBe('FAILED');
  });

  it('back-pressure writes nothing and leaves the step re-leasable rather than failing it', async () => {
    const f = setup();
    f.scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: 'other-attempt',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    const attemptsBefore = (f.db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;

    const result = await run(f, succeedingRunner);

    expect(result.outcome).toBe('ADMISSION_REFUSED');
    const attemptsAfter = (f.db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;
    expect(attemptsAfter).toBe(attemptsBefore); // §2.2: no execution record
    // Not FAILED — contention is transient, so the step must stay retryable.
    expect(f.runSteps.get(f.step.id)?.status).not.toBe('FAILED');
  });

  it('a superseded lease is fenced: the native result is quarantined, never committed, and the step is not failed', async () => {
    const f = setup();
    const result = await run(f, async (attempt) => {
      // While "running", another worker takes the lease over — the exact §7.1 race.
      f.runSteps.lease('run-1', { owner: 'worker-b', leaseDurationMs: LEASE_MS, now: () => new Date(Date.now() + LEASE_MS * 2) });
      expect(attempt.executionAttemptId).toBeTruthy();
      return { ok: true, nativeResultRef: 'local:sha256:' + 'b'.repeat(64), observations: [{ observation: validObservation('obs-2'), event: validEvent('obs-2') }] };
    });

    expect(result.outcome).toBe('FENCED');
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(0);
    expect(f.events.listByCampaign('campaign-1')).toHaveLength(0);
    expect(f.attempts.quarantineHistory(f.step.id).length).toBeGreaterThan(0);
  });

  it('a policy requiring approval writes nothing and leaves the step re-leasable, same treatment as back-pressure (грань №12)', async () => {
    const f = setup();
    const approvals = new PendingApprovalStore(f.db);
    const gate: ApprovalGate = { policy: { requiresApproval: () => true }, approvals };
    const attemptsBefore = (f.db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;

    const result = await executeLeasedStep(f.db, f.runSteps, f.attempts, f.observations, f.events, f.scheduler, f.authProvider, request(f.step.id), succeedingRunner, OWNER, undefined, gate);

    expect(result.outcome).toBe('ASK_PENDING');
    if (result.outcome !== 'ASK_PENDING') return;
    expect(approvals.get(f.step.id)?.approvalId).toBe(result.approvalId);
    const attemptsAfter = (f.db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;
    expect(attemptsAfter).toBe(attemptsBefore); // no execution record, same as ADMISSION_REFUSED
    expect(f.runSteps.get(f.step.id)?.status).not.toBe('FAILED'); // stays retryable, not burned
  });

  it('once approved out-of-band, a re-leased retry through executeLeasedStep() runs the whole path normally', async () => {
    const f = setup();
    const approvals = new PendingApprovalStore(f.db);
    const gate: ApprovalGate = { policy: { requiresApproval: () => true }, approvals };

    const asked = await executeLeasedStep(f.db, f.runSteps, f.attempts, f.observations, f.events, f.scheduler, f.authProvider, request(f.step.id), succeedingRunner, OWNER, undefined, gate);
    if (asked.outcome !== 'ASK_PENDING') throw new Error('expected ASK_PENDING');
    approvals.resolve(asked.approvalId, 'APPROVED', 'operator-1');

    // The step is still leased by the same owner (never failed, never re-leased away)
    // — a real worker's next poll of the same assessment run would pick it up again;
    // here the retry is driven directly, the same shape run()'s own helper uses.
    const retried = await executeLeasedStep(f.db, f.runSteps, f.attempts, f.observations, f.events, f.scheduler, f.authProvider, request(f.step.id), succeedingRunner, OWNER, undefined, gate);
    expect(retried.outcome).toBe('COMMITTED');
  });

  it('грань №17: a runner producing zero observations still COMMITs — a clean scan is a real, successful attempt, not a failure', async () => {
    const f = setup();
    const result = await run(f, async () => ({ ok: true, nativeResultRef: 'local:sha256:' + 'c'.repeat(64), observations: [] }));

    expect(result.outcome).toBe('COMMITTED');
    if (result.outcome !== 'COMMITTED') return;
    expect(result.observations).toEqual([]);
    expect(result.attempt.terminalReason).toBe('COMPLETED');
    expect(f.observations.listByAssessmentRun('run-1')).toHaveLength(0);
    expect(f.events.listByCampaign('campaign-1')).toHaveLength(0);
    expect(f.runSteps.get(f.step.id)?.status).toBe('SUCCEEDED');
    expect(f.scheduler.activeReservations()).toHaveLength(0);
  });

  it('грань №17: a runner producing several observations commits every one of them under the same attempt, not once each', async () => {
    const f = setup();
    const result = await run(f, async () => ({
      ok: true,
      nativeResultRef: 'local:sha256:' + 'd'.repeat(64),
      observations: [
        { observation: validObservation('obs-multi-1'), event: validEvent('obs-multi-1') },
        { observation: validObservation('obs-multi-2'), event: validEvent('obs-multi-2') },
        { observation: validObservation('obs-multi-3'), event: validEvent('obs-multi-3') },
      ],
    }));

    expect(result.outcome).toBe('COMMITTED');
    if (result.outcome !== 'COMMITTED') return;
    expect(result.observations.map((o) => o.observationId)).toEqual(['obs-multi-1', 'obs-multi-2', 'obs-multi-3']);
    expect(result.observations.every((o) => !o.deduped)).toBe(true);
    expect(result.attempt.terminalReason).toBe('COMPLETED');

    const stored = f.observations.listByAssessmentRun('run-1');
    expect(stored).toHaveLength(3);
    // All three share the one attempt this single runner call was given — not three separate attempts.
    expect(stored.every((o) => o.executionAttemptId === result.attempt.executionAttemptId)).toBe(true);
    expect(f.events.listByCampaign('campaign-1')).toHaveLength(3);
    expect(f.runSteps.get(f.step.id)?.status).toBe('SUCCEEDED');
    expect(f.scheduler.activeReservations()).toHaveLength(0);
  });

  it('imports no adapter — the engine composition is the caller\'s closure, not this module\'s dependency', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/execution/run-step-executor.ts', import.meta.url), 'utf-8');
    const importLines = source.split('\n').filter((l) => l.trimStart().startsWith('import '));
    expect(importLines.some((l) => l.includes('adapters/'))).toBe(false);
  });
});

describe('leaseWithConcurrencyPrecheck (грань №19)', () => {
  function unleasedSetup() {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const scheduler = new ConcurrencyScheduler(db);
    const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1' });
    return { runSteps, scheduler, step };
  }

  it('leases the step and returns it when concurrency is clear', () => {
    const { runSteps, scheduler, step } = unleasedSetup();
    const result = leaseWithConcurrencyPrecheck(runSteps, scheduler, 'run-1', step.id, request(step.id), { owner: OWNER, leaseDurationMs: LEASE_MS });
    expect(result.outcome).toBe('LEASED');
    if (result.outcome !== 'LEASED') return;
    expect(result.step.id).toBe(step.id);
    expect(result.step.status).toBe('LEASED');
    expect(result.step.leaseGeneration).toBe(1);
  });

  it('does not lease at all when concurrency would refuse — lease_generation stays 0', () => {
    const { runSteps, scheduler, step } = unleasedSetup();
    scheduler.reserve({ campaignId: 'campaign-1', executionAttemptId: 'holder', declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }] });

    const result = leaseWithConcurrencyPrecheck(runSteps, scheduler, 'run-1', step.id, request(step.id), { owner: OWNER, leaseDurationMs: LEASE_MS });
    expect(result).toMatchObject({ outcome: 'BLOCKED', reason: 'CONFLICT' });

    const after = runSteps.get(step.id);
    expect(after?.status).toBe('PENDING');
    expect(after?.leaseGeneration).toBe(0);
  });

  it('returns RACED when the targeted step was already leased away between peek and this call', () => {
    const { runSteps, scheduler, step } = unleasedSetup();
    runSteps.lease('run-1', { owner: 'other-worker', leaseDurationMs: LEASE_MS }); // simulates a racing caller

    const result = leaseWithConcurrencyPrecheck(runSteps, scheduler, 'run-1', step.id, request(step.id), { owner: OWNER, leaseDurationMs: LEASE_MS });
    expect(result).toEqual({ outcome: 'RACED' });
  });
});
