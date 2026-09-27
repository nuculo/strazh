import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { commitFencedObservation } from '../../src/pipeline/commit-fenced-observation.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { evaluateAuthorization, type AuthorizeEffectRequest } from '../../src/execution/authorization.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import { admitDispatch, type DispatchGuardRequest } from '../../src/execution/dispatch.js';
import { replay } from '../../src/world/replay.js';
import type { Principal } from '../../src/authz/types.js';

const LEASE_MS = 1000;

function validObservation(id: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1:strategy-1',
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
  };
}

/**
 * Phase 4.5.3 vertical slice: authorization gates dispatch (denied for a VIEWER and
 * for a cross-tenant OPERATOR, granted for a same-tenant OPERATOR), the granted
 * request reserves a TARGET_SERIAL scheduler barrier before any effect starts, a
 * concurrent request on the same target is rejected while the barrier holds, and
 * only after release + a genuine dispatch does the result commit and replay
 * through the unmodified Phase 4 world reducer.
 */
describe('Phase 4.5.3 vertical slice: authorization and scheduling', () => {
  it('authorization and the concurrency barrier both gate dispatch before any effect starts', () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);
    const authProvider = new RoleBasedAuthorizationProvider();
    const scheduler = new ConcurrencyScheduler(db);

    const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1:strategy-1' });

    const baseAuthRequest: AuthorizeEffectRequest = {
      principal: { subjectId: 'operator-1', tenantId: 'tenant-a', roles: ['OPERATOR'] },
      resourceTenantId: 'tenant-a',
      campaignId: 'campaign-1',
      assessmentRunId: 'run-1',
      runStepId: step.id,
      operationFamily: 'llm-attack',
      targetSnapshotRef: 'target-snapshot-1',
      adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' },
      declaredCapabilityDigest: 'digest-1',
      expectedCapabilityDigest: 'digest-1',
      policyRevision: 'policy-v1',
      sandboxProfileRef: 'sandbox-1',
      egressPolicyRef: 'egress-1',
      receiptDurationMs: 60_000,
    };

    // A VIEWER cannot dispatch at all.
    const viewerAttempt = evaluateAuthorization(
      { ...baseAuthRequest, principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } },
      authProvider,
    );
    expect(viewerAttempt).toMatchObject({ authorized: false, reason: 'POLICY_DENIED' });

    // A cross-tenant OPERATOR cannot dispatch against tenant-a's resource.
    const crossTenantAttempt = evaluateAuthorization({ ...baseAuthRequest, resourceTenantId: 'tenant-b' }, authProvider);
    expect(crossTenantAttempt).toMatchObject({ authorized: false, reason: 'POLICY_DENIED' });

    // The rightful OPERATOR is authorized.
    const authorized = evaluateAuthorization(baseAuthRequest, authProvider);
    expect(authorized.authorized).toBe(true);
    if (!authorized.authorized) return;

    // Before dispatch, reserve the scheduler barrier — TARGET_SERIAL on this target.
    const reservation = scheduler.reserve({
      campaignId: 'campaign-1',
      executionAttemptId: 'pending-attempt',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) return;

    // A second, concurrent request on the same target is rejected while the barrier holds.
    const concurrent = scheduler.reserve({
      campaignId: 'campaign-2',
      executionAttemptId: 'other-attempt',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    expect(concurrent.reserved).toBe(false);

    // Dispatch: start the real attempt now that authorization and the barrier both cleared.
    runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({
      assessmentRunId: 'run-1',
      runStepId: step.id,
      engineAdapterId: 'promptfoo',
      engineAdapterVersion: '0.1.0',
      engineRequestId: 'req-1',
    });

    const observation = validObservation('obs-1');
    const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(0).toISOString() });
    const commit = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
      observation,
      eventInput,
    );
    expect(commit.committed).toBe(true);

    // Release the barrier now that the effect is fully resolved — only then does the previously-blocked request succeed.
    scheduler.release(reservation.reservation.reservationId);
    const afterRelease = scheduler.reserve({
      campaignId: 'campaign-2',
      executionAttemptId: 'other-attempt',
      declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
    });
    expect(afterRelease.reserved).toBe(true);

    const allEvents = events.listByCampaign('campaign-1');
    expect(allEvents).toHaveLength(1);
    const result = replay(allEvents, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
    expect(result.world.entities.get('target-1')).toMatchObject({ type: 'Target' });
  });

  /**
   * Audit finding #7: the same scenario as above, but composed through
   * `admitDispatch()` instead of calling `evaluateAuthorization()` and
   * `ConcurrencyScheduler.reserve()` by hand in the right order with a placeholder
   * executionAttemptId — that hand-composition was the gap. This is the real
   * dispatch path: one admission call, a real attempt with the reservation
   * correctly attributed to it from the start, and `commitFencedObservation()`'s
   * settleAttempt() releasing the reservation atomically with the commit.
   */
  it('admitDispatch() + commitFencedObservation(scheduler) compose the same guarantees as one real dispatch path', () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);
    const authProvider = new RoleBasedAuthorizationProvider();
    const scheduler = new ConcurrencyScheduler(db);

    const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1:strategy-1' });
    runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: LEASE_MS });

    const baseAuthRequest: AuthorizeEffectRequest = {
      principal: { subjectId: 'operator-1', tenantId: 'tenant-a', roles: ['OPERATOR'] },
      resourceTenantId: 'tenant-a',
      campaignId: 'campaign-1',
      assessmentRunId: 'run-1',
      runStepId: step.id,
      operationFamily: 'llm-attack',
      targetSnapshotRef: 'target-snapshot-1',
      adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' },
      declaredCapabilityDigest: 'digest-1',
      expectedCapabilityDigest: 'digest-1',
      policyRevision: 'policy-v1',
      sandboxProfileRef: 'sandbox-1',
      egressPolicyRef: 'egress-1',
      receiptDurationMs: 60_000,
    };

    // A VIEWER's admission attempt is denied, and durably recorded as such.
    const viewerRequest: DispatchGuardRequest = {
      authorization: { ...baseAuthRequest, principal: { subjectId: 'viewer-1', tenantId: 'tenant-a', roles: ['VIEWER'] } },
      concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-viewer' },
    };
    const viewerResult = admitDispatch(authProvider, scheduler, attempts, viewerRequest);
    expect(viewerResult.admitted).toBe(false);
    if (!viewerResult.admitted) {
      expect(viewerResult.attempt.terminalReason).toBe('AUTHORIZATION_DENIED');
    }
    expect(scheduler.activeReservations()).toHaveLength(0);

    // The rightful OPERATOR is admitted: authorized, and the barrier reserved
    // against the real attempt (not a placeholder).
    const admission = admitDispatch(authProvider, scheduler, attempts, {
      authorization: baseAuthRequest,
      concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' },
    });
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    // A concurrent admission on the same target is refused at the concurrency stage
    // while the barrier holds — cleanly, not as a thrown error or a silent drop, and
    // (ARCH_CLAUDE_TRANSFER.md §2.2) without writing an execution record: contention
    // is back-pressure, not a failed run against the target.
    const concurrentAdmission = admitDispatch(authProvider, scheduler, attempts, {
      authorization: { ...baseAuthRequest, runStepId: step.id },
      concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-2' },
    });
    expect(concurrentAdmission.admitted).toBe(false);
    if (!concurrentAdmission.admitted) {
      expect(concurrentAdmission.stage).toBe('CONCURRENCY');
      expect(concurrentAdmission.attempt).toBeNull();
    }

    // Commit — settleAttempt() releases the barrier in the same transaction as
    // marking the attempt COMPLETED, looked up from the attempt id rather than
    // threaded through by the caller.
    const observation = validObservation('obs-2');
    const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(0).toISOString() });
    const commit = commitFencedObservation(
      db,
      observations,
      events,
      attempts,
      { runStepId: step.id, executionAttemptId: admission.attempt.executionAttemptId, nativeResultRef: 'ref-2' },
      observation,
      eventInput,
      new Date(),
      scheduler,
    );
    expect(commit.committed).toBe(true);
    expect(scheduler.activeReservations()).toHaveLength(0); // released automatically, no separate release() call needed

    // Only now does a fresh admission attempt on the same target succeed.
    const afterRelease = admitDispatch(authProvider, scheduler, attempts, {
      authorization: baseAuthRequest,
      concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: true, rateLimitScope: null }],
      attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-3' },
    });
    expect(afterRelease.admitted).toBe(true);

    const allEvents = events.listByCampaign('campaign-1');
    expect(allEvents).toHaveLength(1);
    const result = replay(allEvents, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
    expect(result.world.entities.get('target-1')).toMatchObject({ type: 'Target' });
  });
});
