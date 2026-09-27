import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import { admitDispatch, probeConcurrency, HARDENING_ENFORCED, type ApprovalGate, type ApprovalPolicy, type DispatchGuardRequest } from '../../src/execution/dispatch.js';
import { PendingApprovalStore } from '../../src/execution/approval-store.js';
import type { AuthorizeEffectRequest } from '../../src/execution/authorization.js';
import type { ConcurrencyDeclaration } from '../../src/execution/concurrency.js';

const LEASE_MS = 1000;

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1' });
  runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: LEASE_MS });
  return { db, runSteps, attempts, scheduler, authProvider, step };
}

function baseAuthRequest(runStepId: string, overrides: Partial<AuthorizeEffectRequest> = {}): AuthorizeEffectRequest {
  return {
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
    ...overrides,
  };
}

const targetSerialDeclaration: ConcurrencyDeclaration = {
  concurrencyClass: 'TARGET_SERIAL',
  resourceKeys: ['target-1'],
  maxInFlight: null,
  supportsCancellation: true,
  destructive: true,
  rateLimitScope: null,
};

describe('admitDispatch', () => {
  it('admits when authorization and the concurrency reservation both clear, and the reservation carries the real executionAttemptId', () => {
    const { attempts, scheduler, authProvider, step } = setup();
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };

    const result = admitDispatch(authProvider, scheduler, attempts, request);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    expect(result.attempt.terminalReason).toBeNull();
    expect(result.attempt.concurrencyClass).toBe('TARGET_SERIAL');
    const active = scheduler.activeReservations();
    expect(active).toHaveLength(1);
    expect(active[0]!.reservationId).toBe(result.reservationId);
    expect(active[0]!.executionAttemptId).toBe(result.attempt.executionAttemptId); // not a placeholder — the real attempt

    const stored = attempts.get(result.attempt.executionAttemptId);
    expect(stored?.terminalReason).toBeNull();
  });

  it('a VIEWER is denied before any reservation is attempted, and the attempt is durably marked AUTHORIZATION_DENIED', () => {
    const { attempts, scheduler, authProvider, step } = setup();
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };

    const result = admitDispatch(authProvider, scheduler, attempts, request);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.stage).toBe('AUTHORIZATION');
    expect(result.reason).toBe('POLICY_DENIED');
    // The returned attempt itself must already reflect termination, not a stale
    // pre-markTerminal() reference — a real bug caught here: admitDispatch()
    // originally discarded markTerminal()'s return value and returned the object
    // captured before it, which still showed terminalReason: null.
    expect(result.attempt.terminalReason).toBe('AUTHORIZATION_DENIED');
    expect(result.attempt.terminatedAt).not.toBeNull();

    expect(scheduler.activeReservations()).toHaveLength(0); // never attempted
    const stored = attempts.get(result.attempt.executionAttemptId);
    expect(stored?.terminalReason).toBe('AUTHORIZATION_DENIED');
    expect(stored?.terminatedAt).not.toBeNull();
  });

  it('does not strand the barrier if creating the attempt fails after the reservation was taken', () => {
    const { attempts, scheduler, authProvider } = setup();
    // The reservation is now acquired before the attempt row is written, so this is
    // the one window where a failure could leave a barrier with no owner. start()
    // throws for a RunStep that does not exist.
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest('no-such-run-step'),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: 'no-such-run-step', engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };

    expect(() => admitDispatch(authProvider, scheduler, attempts, request)).toThrow();
    expect(scheduler.activeReservations()).toHaveLength(0); // released on the way out, not leaked
  });

  it('a cross-tenant OPERATOR is denied the same way as a VIEWER', () => {
    const { attempts, scheduler, authProvider, step } = setup();
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id, { resourceTenantId: 'tenant-b' }),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };
    const result = admitDispatch(authProvider, scheduler, attempts, request);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe('POLICY_DENIED');
  });

  it('an authorized request that conflicts with an existing reservation is refused at the concurrency stage, writes NO execution record, and never disturbs the holder', () => {
    const { db, attempts, scheduler, authProvider, step } = setup();
    const holder = scheduler.reserve({ campaignId: 'campaign-1', executionAttemptId: 'holder-attempt', declarations: [targetSerialDeclaration] });
    expect(holder.reserved).toBe(true);
    const attemptsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;

    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-2' },
    };
    const result = admitDispatch(authProvider, scheduler, attempts, request);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.stage).toBe('CONCURRENCY');
    expect(result.reason).toBe('CONFLICT');

    // ARCH_CLAUDE_TRANSFER.md §2.2: contention is back-pressure, not a failed
    // execution. Before this change the refusal minted an attempt and terminalized
    // it TARGET_UNAVAILABLE — a durable claim of a failed run against the target,
    // indistinguishable from one that was genuinely unreachable.
    expect(result.attempt).toBeNull();
    const attemptsAfter = (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;
    expect(attemptsAfter).toBe(attemptsBefore);

    // The original holder's reservation is untouched by the refused challenger.
    const active = scheduler.activeReservations();
    expect(active).toHaveLength(1);
    expect(active[0]!.executionAttemptId).toBe('holder-attempt');
  });

  it('the attempt\'s concurrencyClass reflects the strictest declaration supplied, matching what was actually reserved', () => {
    const { attempts, scheduler, authProvider, step } = setup();
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id),
      concurrency: [
        { concurrencyClass: 'READ_ONLY_PARALLEL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null },
        { concurrencyClass: 'CAMPAIGN_SERIAL', resourceKeys: ['campaign-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null },
      ],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };
    const result = admitDispatch(authProvider, scheduler, attempts, request);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.attempt.concurrencyClass).toBe('CAMPAIGN_SERIAL'); // stricter than READ_ONLY_PARALLEL
  });

  describe('HardeningConfig (§15 criterion 14 — the rollback drill this makes provable)', () => {
    it('HARDENING_ENFORCED (the default) behaves exactly as calling with no hardening argument at all', () => {
      const { attempts, scheduler, authProvider, step } = setup();
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };
      const result = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED);
      expect(result.admitted).toBe(false);
      if (result.admitted) return;
      expect(result.stage).toBe('AUTHORIZATION');
    });

    it('authorizationEnforced:false admits a VIEWER that HARDENING_ENFORCED would deny, and returns a null authorizationReceipt rather than a fabricated one', () => {
      const { attempts, scheduler, authProvider, step } = setup();
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };
      const result = admitDispatch(authProvider, scheduler, attempts, request, undefined, { authorizationEnforced: false });
      expect(result.admitted).toBe(true);
      if (!result.admitted) return;
      expect(result.authorizationReceipt).toBeNull();
      expect(result.attempt.terminalReason).toBeNull();
    });

    it('authorizationEnforced:false still reserves the concurrency barrier — only authorization is bypassed, not the whole admission gate', () => {
      const { attempts, scheduler, authProvider, step } = setup();
      const holder = scheduler.reserve({ campaignId: 'campaign-1', executionAttemptId: 'holder-attempt', declarations: [targetSerialDeclaration] });
      expect(holder.reserved).toBe(true);

      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };
      const result = admitDispatch(authProvider, scheduler, attempts, request, undefined, { authorizationEnforced: false });
      expect(result.admitted).toBe(false);
      if (result.admitted) return;
      expect(result.stage).toBe('CONCURRENCY'); // a VIEWER, bypassed past authorization, still contends for the barrier like anyone else
    });

    it('fencing rejects a stale result from a bypass-admitted attempt exactly as it would one admitted while enforced', () => {
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();
      const now0 = new Date(0);
      const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1' });
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS, now: () => now0 });

      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };
      const result = admitDispatch(authProvider, scheduler, attempts, request, now0, { authorizationEnforced: false });
      expect(result.admitted).toBe(true);
      if (!result.admitted) return;

      // A competing worker takes over the step after the lease expires.
      const now1 = new Date(LEASE_MS + 1);
      runSteps.lease('run-1', { owner: 'w2', leaseDurationMs: LEASE_MS, now: () => now1 });

      const bind = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: result.attempt.executionAttemptId, nativeResultRef: 'ref-1' }, now1);
      expect(bind.permitted).toBe(false);
      if (bind.permitted) return;
      expect(bind.reason).toBe('STALE_LEASE_RESULT');
    });
  });

  describe('ApprovalGate (грань №12 — "ask," adapted as a durable, re-leasable request rather than an in-memory suspended Promise)', () => {
    const ALWAYS_ASK: ApprovalPolicy = { requiresApproval: () => true };

    it('a policy that requires approval refuses admission with stage ASK, writes no execution record, and creates a durable PendingApproval', () => {
      const { db, attempts, scheduler, authProvider, step } = setup();
      const approvals = new PendingApprovalStore(db);
      const gate: ApprovalGate = { policy: ALWAYS_ASK, approvals };
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };

      const result = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      expect(result.admitted).toBe(false);
      if (result.admitted) return;
      expect(result.stage).toBe('ASK');
      if (result.stage !== 'ASK') return;
      expect(result.attempt).toBeNull();
      expect(scheduler.activeReservations()).toHaveLength(0);

      const pending = approvals.get(step.id);
      expect(pending?.approvalId).toBe(result.approvalId);
      expect(pending?.decision).toBeNull();
    });

    it('requesting admission again for the same still-pending RunStep returns the same approvalId, not a second ask', () => {
      const { db, attempts, scheduler, authProvider, step } = setup();
      const approvals = new PendingApprovalStore(db);
      const gate: ApprovalGate = { policy: ALWAYS_ASK, approvals };
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };

      const first = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      const second = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      expect(first.admitted).toBe(false);
      expect(second.admitted).toBe(false);
      if (first.admitted || second.admitted) return;
      expect(first.stage).toBe('ASK');
      expect(second.stage).toBe('ASK');
      if (first.stage !== 'ASK' || second.stage !== 'ASK') return;
      expect(second.approvalId).toBe(first.approvalId);
    });

    it('once approved out-of-band, the next admitDispatch() call for the same RunStep is admitted normally', () => {
      const { db, attempts, scheduler, authProvider, step } = setup();
      const approvals = new PendingApprovalStore(db);
      const gate: ApprovalGate = { policy: ALWAYS_ASK, approvals };
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };

      const asked = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      expect(asked.admitted).toBe(false);
      if (asked.admitted || asked.stage !== 'ASK') return;

      const resolved = approvals.resolve(asked.approvalId, 'APPROVED', 'operator-1');
      expect(resolved.resolved).toBe(true);

      const retried = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      expect(retried.admitted).toBe(true);
      if (!retried.admitted) return;
      expect(retried.attempt.terminalReason).toBeNull();
      expect(scheduler.activeReservations()).toHaveLength(1);
    });

    it('once denied out-of-band, the next admitDispatch() call rejects at stage AUTHORIZATION with a durable terminal attempt', () => {
      const { db, attempts, scheduler, authProvider, step } = setup();
      const approvals = new PendingApprovalStore(db);
      const gate: ApprovalGate = { policy: ALWAYS_ASK, approvals };
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };

      const asked = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      if (asked.admitted || asked.stage !== 'ASK') return;
      approvals.resolve(asked.approvalId, 'DENIED', 'operator-1');

      const retried = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      expect(retried.admitted).toBe(false);
      if (retried.admitted) return;
      expect(retried.stage).toBe('AUTHORIZATION');
      if (retried.stage !== 'AUTHORIZATION') return;
      expect(retried.attempt.terminalReason).toBe('AUTHORIZATION_DENIED');
      expect(retried.detail).toContain('operator-1');
      expect(scheduler.activeReservations()).toHaveLength(0);
    });

    it('a request evaluateAuthorization() would deny on its own is never even offered to the approval policy', () => {
      const { attempts, scheduler, authProvider, step, db } = setup();
      const approvals = new PendingApprovalStore(db);
      let policyWasAsked = false;
      const suspiciousPolicy: ApprovalPolicy = { requiresApproval: () => ((policyWasAsked = true), true) };
      const gate: ApprovalGate = { policy: suspiciousPolicy, approvals };

      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };
      const result = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      expect(result.admitted).toBe(false);
      if (result.admitted) return;
      expect(result.stage).toBe('AUTHORIZATION'); // not ASK — a VIEWER was already going to be denied
      expect(policyWasAsked).toBe(false);
    });

    it('with no ApprovalGate supplied at all, an ALWAYS_ASK-worthy request is admitted normally — approval is additive, never a default behavior change', () => {
      const { attempts, scheduler, authProvider, step } = setup();
      const request: DispatchGuardRequest = {
        authorization: baseAuthRequest(step.id),
        concurrency: [targetSerialDeclaration],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
      };
      const result = admitDispatch(authProvider, scheduler, attempts, request);
      expect(result.admitted).toBe(true);
    });
  });
});

describe('probeConcurrency (грань №19)', () => {
  it('reports wouldAdmit:true when admitDispatch() would actually admit, without leasing or reserving anything', () => {
    const { scheduler, step } = setup();
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };
    expect(probeConcurrency(scheduler, request)).toEqual({ wouldAdmit: true });
    expect(scheduler.activeReservations()).toHaveLength(0);
  });

  it('reports the same CONCURRENCY refusal admitDispatch() would give, without writing anything', () => {
    const { attempts, scheduler, authProvider, step } = setup();
    // A holder already occupies the target's barrier.
    scheduler.reserve({ campaignId: 'campaign-1', executionAttemptId: 'holder', declarations: [targetSerialDeclaration] });

    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-2' },
    };

    const probed = probeConcurrency(scheduler, request);
    expect(probed).toMatchObject({ wouldAdmit: false, reason: 'CONFLICT' });

    const real = admitDispatch(authProvider, scheduler, attempts, request);
    expect(real.admitted).toBe(false);
    if (real.admitted) return;
    expect(real.stage).toBe('CONCURRENCY');
    expect(real.reason).toBe(probed.wouldAdmit ? undefined : probed.reason);
  });

  it('does not evaluate authorization at all — an AUTHORIZATION-denying request still probes clean on concurrency alone', () => {
    const { scheduler, step } = setup();
    const request: DispatchGuardRequest = {
      authorization: baseAuthRequest(step.id, { principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } }),
      concurrency: [targetSerialDeclaration],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    };
    // A VIEWER would be denied by the real admitDispatch() at the AUTHORIZATION stage —
    // probeConcurrency() has no opinion on that at all, it only answers the concurrency question.
    expect(probeConcurrency(scheduler, request)).toEqual({ wouldAdmit: true });
  });
});
