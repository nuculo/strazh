import { mulberry32, randInt, randBool, pick } from '../rng.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { RunStepStore } from '../../runsteps/store.js';
import { ExecutionAttemptStore } from '../../execution/execution-attempt-store.js';
import { ObservationStore } from '../../observations/store.js';
import { CampaignEventStore } from '../../events/store.js';
import { commitFencedObservation } from '../../pipeline/commit-fenced-observation.js';
import { eventForObservation } from '../../pipeline/observation-event.js';
import { attemptEffectTransition, legalEventsFrom, type EffectCapability, type EffectLifecycleState } from '../../execution/effect.js';
import { EffectReceiptStore } from '../../execution/effect-receipt-store.js';
import { EffectReconciler } from '../../execution/reconciler.js';
import { decideRecovery, type ReconciliationAction } from '../../execution/reconciliation.js';
import { replay } from '../../world/replay.js';
import { fingerprint } from '../../world/fingerprint.js';
import { evaluateAuthorization, receiptCoversAdapter, type AuthorizeEffectRequest, type AuthorizationRejectionReason } from '../../execution/authorization.js';
import { RoleBasedAuthorizationProvider } from '../../authz/role-based-provider.js';
import { ConcurrencyScheduler } from '../../execution/concurrency-scheduler.js';
import { normalizeConcurrencyClass, type ConcurrencyDeclaration } from '../../execution/concurrency.js';
import { admitDispatch, HARDENING_ENFORCED, type ApprovalGate, type ApprovalPolicy, type DispatchGuardRequest } from '../../execution/dispatch.js';
import { PendingApprovalStore } from '../../execution/approval-store.js';
import { settleAttempt } from '../../execution/settle.js';
import { leaseWithConcurrencyPrecheck } from '../../execution/run-step-executor.js';
import { compilePlan, type InterceptorDescriptor, type InterceptorStage } from '../../execution/interceptor.js';
import { buildEnvelope, safeEmit, type EnvelopeSink } from '../../execution/envelope.js';
import type { ConcurrencyClass, ExecutionAttempt, TerminalReason } from '../../execution/types.js';
import type { AuthorizationDecision, AuthorizationProvider, AuthorizationRequest, Principal } from '../../authz/types.js';
import type { Law } from '../types.js';

/** грань №19: counts `authorize()` calls, so a law can prove the concurrency precheck never reaches it. */
class SpyAuthorizationProvider implements AuthorizationProvider {
  calls = 0;
  constructor(private readonly inner: AuthorizationProvider) {}
  authorize(request: AuthorizationRequest): AuthorizationDecision {
    this.calls += 1;
    return this.inner.authorize(request);
  }
}

/** Independent oracle mirroring §6/§12's table directly, so the law catches a regression rather than restating decideRecovery()'s own code. */
function expectedRecoveryAction(
  effectStarted: boolean | null,
  capability: EffectCapability,
  queried: 'CONFIRMED' | 'ABSENT' | 'STILL_UNKNOWN' | undefined,
): ReconciliationAction {
  if (effectStarted === false) return 'RETRY_SAME_EFFECT';
  switch (capability) {
    case 'IDEMPOTENT_BY_KEY':
      return 'RETRY_SAME_EFFECT';
    case 'COMPENSATABLE':
      return 'RUN_COMPENSATION';
    case 'AT_MOST_ONCE_UNPROVEN':
      return 'UNKNOWN_EFFECT_OUTCOME';
    case 'QUERYABLE_RECEIPT':
      if (queried === undefined) return 'QUERY_EXTERNAL_RECEIPT';
      if (queried === 'CONFIRMED') return 'PROCEED_TO_NATIVE_RESULT';
      if (queried === 'ABSENT') return 'RETRY_SAME_EFFECT';
      return 'UNKNOWN_EFFECT_OUTCOME';
  }
}

/** Independent oracle mirroring §8's V→C→P→S precedence order, so the law catches a regression in *which* reason wins under simultaneous failures, not only whether authorization succeeded. */
function expectedAuthorizationReason(
  malformed: boolean,
  digestMismatch: boolean,
  policyDenied: boolean,
  missingSandbox: boolean,
  missingEgress: boolean,
): AuthorizationRejectionReason | null {
  if (malformed) return 'MALFORMED_REQUEST';
  if (digestMismatch) return 'CAPABILITY_DIGEST_MISMATCH';
  if (policyDenied) return 'POLICY_DENIED';
  if (missingSandbox || missingEgress) return 'SANDBOX_OR_EGRESS_POLICY_MISSING';
  return null;
}

const LEASE_DURATION_MS = 1000;

/** Leases the (only) step for `owner` at `atMs`, forcing takeover once the previous lease has expired, and starts an ExecutionAttempt bound to whatever lease generation results. `executionAttemptId` defaults to random; pass a fixed value for tests that must compare two otherwise-identical scenarios. */
function leaseAndStartAttempt(
  runSteps: RunStepStore,
  attempts: ExecutionAttemptStore,
  assessmentRunId: string,
  stepId: string,
  owner: string,
  atMs: number,
  executionAttemptId?: string,
): ExecutionAttempt {
  const step = runSteps.lease(assessmentRunId, { owner, leaseDurationMs: LEASE_DURATION_MS, now: () => new Date(atMs) });
  if (!step) throw new Error(`law setup: expected a leasable step at t=${atMs}`);
  return attempts.start(
    { assessmentRunId, runStepId: stepId, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${owner}-${atMs}` },
    new Date(atMs),
    executionAttemptId,
  );
}

const ALL_CAPABILITIES: EffectCapability[] = ['IDEMPOTENT_BY_KEY', 'QUERYABLE_RECEIPT', 'COMPENSATABLE', 'AT_MOST_ONCE_UNPROVEN'];

/**
 * Runs `rounds` interrupted-and-retried cycles on one RunStep (each: an ambiguous
 * EffectReceipt, a reconciliation that decides IDEMPOTENT_BY_KEY-safe retry, a
 * rejected stray duplicate result on the now-terminal old attempt, then a genuine
 * retry under a new lease generation), then commits a real Observation on the
 * final attempt. Shared by the two laws that need "N recovery rounds happened,
 * then one real commit" as their starting point.
 */
function runRecoveryScenario(seed: number, rounds: number) {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const receipts = new EffectReceiptStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const reconciler = new EffectReconciler(attempts, receipts, scheduler);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);

  const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' }, new Date(0));
  let t = 0;
  let currentAttempt = leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, 'worker-0', t);

  for (let i = 0; i < rounds; i += 1) {
    receipts.record({
      effectId: `effect-${seed}-${i}`,
      executionAttemptId: currentAttempt.executionAttemptId,
      engineAdapterId: 'promptfoo',
      engineRequestId: `req-${i}`,
      idempotencyKey: null,
      capability: 'IDEMPOTENT_BY_KEY',
      startedAt: new Date(t).toISOString(),
      acknowledgedAt: null,
      externalReceiptRef: null,
      reconciliationToken: null,
      outcome: 'UNKNOWN',
    });
    const { decision } = reconciler.reconcile({ executionAttemptId: currentAttempt.executionAttemptId, capability: 'IDEMPOTENT_BY_KEY' });
    if (decision.action !== 'RETRY_SAME_EFFECT') {
      throw new Error(`law setup: expected IDEMPOTENT_BY_KEY to retry on an ambiguous outcome, got ${decision.action}`);
    }
    const dup = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: currentAttempt.executionAttemptId, nativeResultRef: `dup-${i}` });
    if (dup.permitted) {
      throw new Error('law setup: a native result bound to an already-reconciled attempt — reconciler or fencing is broken, cannot proceed with scenario');
    }
    t += LEASE_DURATION_MS + 1;
    currentAttempt = leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, `worker-${i + 1}`, t);
  }

  const observation = validObservation(`obs-${seed}`);
  const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(t).toISOString() });
  const commit = commitFencedObservation(
    db,
    observations,
    events,
    attempts,
    { runStepId: step.id, executionAttemptId: currentAttempt.executionAttemptId, nativeResultRef: 'ref-final' },
    observation,
    eventInput,
    new Date(t),
  );

  return { db, step, attempts, observations, events, commit };
}

function validObservation(id: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1',
    assessmentRunId: 'run-1',
    verdict: 'UNVERIFIED',
    evidenceRefs: [],
    provenance: {
      engineId: 'promptfoo',
      engineVersion: '0.122.0',
      adapterVersion: '0.1.0',
      schemaVersion: '1.0.0',
      nativeRunId: 'native-run-1',
      nativeResultId: id,
      graderKind: 'none',
    },
  };
}

// EXECUTION_SAFETY_RECOVERY.md §16, delivery sub-phase 4.5.1 — Identity and fencing.
export const executionSafetyLaws: Law[] = [
  {
    id: 'redteam.execution/late-result-from-old-lease-is-rejected',
    statement:
      'ExecutionAttemptStore.bindNativeResult() rejects with STALE_LEASE_RESULT for every ExecutionAttempt whose leaseGeneration is not the RunStep\'s current one — a result from generation N never binds once generation N+1 (or later) has been issued, regardless of how many takeovers happened in between.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);

      const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' }, new Date(0));
      const takeovers = randInt(rng, 1, 5);

      const generationsSeen: ExecutionAttempt[] = [];
      let t = 0;
      for (let i = 0; i < takeovers; i += 1) {
        t += LEASE_DURATION_MS + 1; // force the previous lease to have expired
        generationsSeen.push(leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, `worker-${i}`, t));
      }

      const current = generationsSeen[generationsSeen.length - 1]!;
      const stale = generationsSeen.slice(0, -1);

      for (const attempt of stale) {
        const result = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-stale' });
        if (result.permitted || result.reason !== 'STALE_LEASE_RESULT') {
          return {
            held: false,
            detail: 'A result from a superseded lease generation was not rejected as STALE_LEASE_RESULT',
            counterexample: { attempt, currentGeneration: current.leaseGeneration, result },
          };
        }
      }

      const currentResult = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: current.executionAttemptId, nativeResultRef: 'ref-current' });
      if (!currentResult.permitted) {
        return { held: false, detail: 'The attempt bound to the current lease generation was rejected', counterexample: { current, currentResult } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/observation-binds-active-attempt',
    statement:
      'commitFencedObservation() only ever commits an Observation with executionAttemptId set to an ExecutionAttempt that was, at bind time, active (not terminal, and on the RunStep\'s current lease generation) — a stale or terminal attempt never produces a committed Observation, and a successful commit always carries the binding.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const observations = new ObservationStore(db);
      const events = new CampaignEventStore(db);

      const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' }, new Date(0));
      const staleAttempt = leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, 'worker-old', 0);
      const currentAttempt = leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, 'worker-new', LEASE_DURATION_MS + 1);

      const obsId = `obs-${seed}`;
      const observation = validObservation(obsId);
      const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(0).toISOString() });

      const staleCommit = commitFencedObservation(
        db,
        observations,
        events,
        attempts,
        { runStepId: step.id, executionAttemptId: staleAttempt.executionAttemptId, nativeResultRef: 'ref-stale' },
        observation,
        eventInput,
      );
      if (staleCommit.committed) {
        return { held: false, detail: 'A stale-generation attempt was allowed to commit an Observation', counterexample: { staleAttempt, currentAttempt, staleCommit } };
      }
      if (observations.listByAssessmentRun('run-1').length !== 0) {
        return { held: false, detail: 'An Observation was persisted despite the fencing rejection' };
      }

      const shouldTerminal = randInt(rng, 0, 1) === 1;
      if (shouldTerminal) {
        attempts.markTerminal(currentAttempt.executionAttemptId, 'CANCELLED');
        const afterTerminal = commitFencedObservation(
          db,
          observations,
          events,
          attempts,
          { runStepId: step.id, executionAttemptId: currentAttempt.executionAttemptId, nativeResultRef: 'ref-terminal' },
          observation,
          eventInput,
        );
        if (afterTerminal.committed) {
          return { held: false, detail: 'A terminal attempt was allowed to commit an Observation', counterexample: { currentAttempt, afterTerminal } };
        }
        return { held: true };
      }

      const liveCommit = commitFencedObservation(
        db,
        observations,
        events,
        attempts,
        { runStepId: step.id, executionAttemptId: currentAttempt.executionAttemptId, nativeResultRef: 'ref-current' },
        observation,
        eventInput,
      );
      if (!liveCommit.committed) {
        return { held: false, detail: 'A live, current-generation attempt was rejected', counterexample: { currentAttempt, liveCommit } };
      }
      const stored = liveCommit.commit.observation;
      if (stored['executionAttemptId'] !== currentAttempt.executionAttemptId) {
        return { held: false, detail: 'Committed Observation did not carry the ExecutionAttempt binding', counterexample: { stored, currentAttempt } };
      }
      return { held: true };
    },
  },
  // EXECUTION_SAFETY_RECOVERY.md §16, delivery sub-phase 4.5.2 — Effect journal and
  // recovery. Six of §14's remaining ten laws become checkable now that
  // EffectReceipt, the effect lifecycle state machine, capability declarations, and
  // the reconciler exist for real.
  {
    id: 'redteam.execution/effect-start-is-not-commit',
    statement:
      'EFFECT_STARTED is not equivalent to OBSERVATION_COMMITTED: no legal event transitions EFFECT_STARTED directly to OBSERVATION_COMMITTED, and OBSERVATION_COMMITTED is entered only from RESULT_NORMALIZED, verified both structurally and by random walk over the real transition table.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);

      for (const event of legalEventsFrom('EFFECT_STARTED')) {
        const result = attemptEffectTransition('EFFECT_STARTED', event);
        if (result.to === 'OBSERVATION_COMMITTED') {
          return { held: false, detail: 'EFFECT_STARTED transitioned directly to OBSERVATION_COMMITTED', counterexample: { event, result } };
        }
      }

      let state: EffectLifecycleState = 'ADMITTED';
      const steps = randInt(rng, 1, 10);
      for (let i = 0; i < steps; i += 1) {
        const events = legalEventsFrom(state);
        if (events.length === 0) break;
        const event = pick(rng, events);
        const result = attemptEffectTransition(state, event);
        if (!result.allowed) {
          return { held: false, detail: 'legalEventsFrom() returned an event attemptEffectTransition rejected', counterexample: { state, event } };
        }
        const previous = state;
        state = result.to;
        if (state === 'OBSERVATION_COMMITTED' && previous !== 'RESULT_NORMALIZED') {
          return { held: false, detail: 'OBSERVATION_COMMITTED was entered from a state other than RESULT_NORMALIZED', counterexample: { previous, state } };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/unknown-effect-is-not-auto-retried',
    statement:
      "decideRecovery() never returns RETRY_SAME_EFFECT for AT_MOST_ONCE_UNPROVEN when the effect's start is not proven false, and never returns anything but QUERY_EXTERNAL_RECEIPT for QUERYABLE_RECEIPT before a query has actually been performed — an unresolved outcome is never silently retried.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const effectStarted = pick(rng, [true, null] as const);
      const capability = pick(rng, ALL_CAPABILITIES);
      const decision = decideRecovery({ effectStarted, capability });

      if (capability === 'AT_MOST_ONCE_UNPROVEN' && decision.action === 'RETRY_SAME_EFFECT') {
        return { held: false, detail: 'AT_MOST_ONCE_UNPROVEN was auto-retried on an unresolved outcome', counterexample: { effectStarted, capability, decision } };
      }
      if (capability === 'QUERYABLE_RECEIPT' && decision.action !== 'QUERY_EXTERNAL_RECEIPT') {
        return { held: false, detail: 'QUERYABLE_RECEIPT skipped querying and went straight to a retry/outcome decision', counterexample: { effectStarted, capability, decision } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/retry-follows-adapter-capability',
    statement:
      "decideRecovery()'s action always matches §6/§12's table exactly: IDEMPOTENT_BY_KEY retries, COMPENSATABLE compensates, AT_MOST_ONCE_UNPROVEN is unknown, QUERYABLE_RECEIPT queries first then branches on the query outcome, and a proven-false effect start always retries regardless of capability.",
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const effectStarted = pick(rng, [true, false, null] as const);
      const capability = pick(rng, ALL_CAPABILITIES);
      const queried = capability === 'QUERYABLE_RECEIPT' && randBool(rng) ? pick(rng, ['CONFIRMED', 'ABSENT', 'STILL_UNKNOWN'] as const) : undefined;

      const decision = decideRecovery({ effectStarted, capability, ...(queried !== undefined ? { queriedReceiptOutcome: queried } : {}) });
      const expected = expectedRecoveryAction(effectStarted, capability, queried);
      if (decision.action !== expected) {
        return { held: false, detail: `expected ${expected}, got ${decision.action}`, counterexample: { effectStarted, capability, queried, decision } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/authorization-precedes-effect',
    statement:
      'evaluateAuthorization() issues an AuthorizationReceipt iff every §8 pipeline stage passes (well-formed request, matching capability digest, RTAP policy allows run-step:dispatch, both sandbox and egress refs declared) — a failure at any single stage, alone or combined, never issues a receipt; when several stages fail simultaneously, the reported reason is always the one earliest in the fixed V→C→P→S precedence order, never any other failing stage; and an issued receipt always carries the exact identity it was evaluated against.',
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const provider = new RoleBasedAuthorizationProvider();
      const role = pick(rng, ['VIEWER', 'OPERATOR', 'ADMIN'] as const); // only OPERATOR/ADMIN permit run-step:dispatch
      const crossTenant = randBool(rng, 0.3);
      const principal: Principal = { subjectId: 'subject-1', tenantId: 'tenant-a', roles: [role] };
      const resourceTenantId = crossTenant ? 'tenant-b' : 'tenant-a';

      // V — malformed independently of the other three stages, so a trial can combine
      // "this request is malformed" with "and it would also fail every later stage,"
      // proving MALFORMED_REQUEST still wins even when nothing downstream would pass either.
      const malformed = randBool(rng, 0.25);
      const malformedField = pick(rng, ['campaignId', 'assessmentRunId', 'runStepId', 'operationFamily', 'targetSnapshotRef', 'adapterId', 'adapterVersion', 'policyRevision'] as const);
      const digestMismatch = randBool(rng, 0.3);
      const missingSandbox = randBool(rng, 0.3);
      const missingEgress = randBool(rng, 0.3);

      const request: AuthorizeEffectRequest = {
        principal,
        resourceTenantId,
        campaignId: malformed && malformedField === 'campaignId' ? '' : 'campaign-1',
        assessmentRunId: malformed && malformedField === 'assessmentRunId' ? '' : 'run-1',
        runStepId: malformed && malformedField === 'runStepId' ? '' : 'step-1',
        operationFamily: malformed && malformedField === 'operationFamily' ? '' : 'llm-attack',
        targetSnapshotRef: malformed && malformedField === 'targetSnapshotRef' ? '' : 'target-snapshot-1',
        adapterIdentity: {
          engineAdapterId: malformed && malformedField === 'adapterId' ? '' : 'promptfoo',
          engineAdapterVersion: malformed && malformedField === 'adapterVersion' ? '' : '0.1.0',
        },
        declaredCapabilityDigest: digestMismatch ? 'digest-declared' : 'digest-expected',
        expectedCapabilityDigest: 'digest-expected',
        policyRevision: malformed && malformedField === 'policyRevision' ? '' : 'policy-v1',
        sandboxProfileRef: missingSandbox ? null : 'sandbox-1',
        egressPolicyRef: missingEgress ? null : 'egress-1',
        receiptDurationMs: 60_000,
      };

      const result = evaluateAuthorization(request, provider);
      const policyWouldAllow = !crossTenant && (role === 'OPERATOR' || role === 'ADMIN');
      const expectedReason = expectedAuthorizationReason(malformed, digestMismatch, !policyWouldAllow, missingSandbox, missingEgress);
      const expectedAuthorized = expectedReason === null;

      if (result.authorized !== expectedAuthorized) {
        return {
          held: false,
          detail: `expected authorized=${expectedAuthorized}, got ${result.authorized}`,
          counterexample: { role, crossTenant, malformed, malformedField, digestMismatch, missingSandbox, missingEgress, result },
        };
      }
      if (!result.authorized) {
        if (result.reason !== expectedReason) {
          return {
            held: false,
            detail: `expected the earliest-precedence failing stage (${expectedReason}) to win, got ${result.reason}`,
            counterexample: { malformed, malformedField, digestMismatch, policyDenied: !policyWouldAllow, missingSandbox, missingEgress, result },
          };
        }
      }
      if (result.authorized) {
        if (
          result.receipt.runStepId !== request.runStepId ||
          result.receipt.adapterIdentity.engineAdapterId !== request.adapterIdentity.engineAdapterId ||
          result.receipt.adapterCapabilityDigest !== request.declaredCapabilityDigest
        ) {
          return { held: false, detail: 'issued receipt did not carry the exact identity it was evaluated against', counterexample: { request, receipt: result.receipt } };
        }
        if (!receiptCoversAdapter(result.receipt, request.adapterIdentity, request.declaredCapabilityDigest)) {
          return { held: false, detail: 'receiptCoversAdapter() rejected the exact adapter/digest the receipt was just issued for', counterexample: result.receipt };
        }
        if (receiptCoversAdapter(result.receipt, { ...request.adapterIdentity, engineAdapterVersion: 'other-version' }, request.declaredCapabilityDigest)) {
          return { held: false, detail: 'receiptCoversAdapter() accepted a version it was not issued for', counterexample: result.receipt };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/effect-id-stable-only-for-safe-retry',
    statement:
      "decideRecovery() only ever returns RETRY_SAME_EFFECT (§12 node I, labeled \"retry same effect id and key\") on a provably safe basis: the effect's start was proven false, or the capability is IDEMPOTENT_BY_KEY, or a query already confirmed the effect was absent — never for COMPENSATABLE or AT_MOST_ONCE_UNPROVEN on an unresolved outcome.",
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const effectStarted = pick(rng, [true, false, null] as const);
      const capability = pick(rng, ALL_CAPABILITIES);
      const queried = capability === 'QUERYABLE_RECEIPT' && randBool(rng) ? pick(rng, ['CONFIRMED', 'ABSENT', 'STILL_UNKNOWN'] as const) : undefined;
      const decision = decideRecovery({ effectStarted, capability, ...(queried !== undefined ? { queriedReceiptOutcome: queried } : {}) });

      if (decision.action === 'RETRY_SAME_EFFECT') {
        const provenSafe = effectStarted === false || capability === 'IDEMPOTENT_BY_KEY' || (capability === 'QUERYABLE_RECEIPT' && queried === 'ABSENT');
        if (!provenSafe) {
          return { held: false, detail: 'RETRY_SAME_EFFECT was produced without a proven-safe basis', counterexample: { effectStarted, capability, queried, decision } };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/unknown-concurrency-is-exclusive',
    statement:
      "An UNKNOWN concurrency declaration behaves exactly as EXCLUSIVE would in ConcurrencyScheduler: it is rejected whenever anything else already holds a reservation, and once granted (as the first reservation), it blocks every subsequent reservation regardless of that reservation's own declared class — never optimistic parallel execution.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      if (normalizeConcurrencyClass('UNKNOWN') !== 'EXCLUSIVE') {
        return { held: false, detail: 'normalizeConcurrencyClass(UNKNOWN) did not normalize to EXCLUSIVE' };
      }

      const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
      const otherClasses: ConcurrencyClass[] = ['READ_ONLY_PARALLEL', 'TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE', 'UNKNOWN'];

      // An UNKNOWN request is rejected once anything else already holds a reservation.
      const first = scheduler.reserve({
        campaignId: 'campaign-1',
        executionAttemptId: 'attempt-holder',
        declarations: [{ concurrencyClass: pick(rng, otherClasses), resourceKeys: ['res-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
      });
      if (!first.reserved) {
        return { held: false, detail: 'law setup: the first (holder) reservation was unexpectedly rejected', counterexample: first };
      }
      const unknownAttempt = scheduler.reserve({
        campaignId: 'campaign-2',
        executionAttemptId: 'attempt-unknown-1',
        declarations: [{ concurrencyClass: 'UNKNOWN', resourceKeys: ['res-unrelated'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
      });
      if (unknownAttempt.reserved) {
        return { held: false, detail: 'an UNKNOWN declaration was granted alongside an existing reservation on an unrelated resource/campaign', counterexample: { first, unknownAttempt } };
      }
      scheduler.release(first.reservation.reservationId);

      // Once an UNKNOWN reservation is granted (barrier now empty), it blocks every subsequent request, of any class, on any unrelated resource/campaign.
      const unknownFirst = scheduler.reserve({
        campaignId: 'campaign-3',
        executionAttemptId: 'attempt-unknown-2',
        declarations: [{ concurrencyClass: 'UNKNOWN', resourceKeys: ['res-2'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
      });
      if (!unknownFirst.reserved) {
        return { held: false, detail: 'law setup: an UNKNOWN reservation against an empty barrier was unexpectedly rejected', counterexample: unknownFirst };
      }
      const blocked = scheduler.reserve({
        campaignId: 'campaign-4',
        executionAttemptId: 'attempt-blocked',
        declarations: [{ concurrencyClass: pick(rng, otherClasses), resourceKeys: ['res-unrelated-2'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
      });
      if (blocked.reserved) {
        return { held: false, detail: 'a reservation was granted alongside an active UNKNOWN (EXCLUSIVE) reservation', counterexample: { unknownFirst, blocked } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/interceptor-order-is-deterministic',
    statement:
      'compilePlan() is a function of the descriptor *set*, not the order it was supplied in: shuffling the same descriptors always yields the same orderedDescriptors sequence and the same planDigest, while a genuinely different descriptor set yields a different digest.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const stages: InterceptorStage[] = ['PRE_DISPATCH', 'POST_NATIVE_RESULT', 'PRE_NORMALIZATION', 'POST_OBSERVATION_COMMIT', 'PRE_REPORT'];
      const count = randInt(rng, 2, 8);
      const descriptors: InterceptorDescriptor[] = Array.from({ length: count }, (_, i) => ({
        interceptorId: `interceptor-${i}-${randInt(rng, 0, 999)}`,
        version: '1.0.0',
        stage: pick(rng, stages),
        criticality: pick(rng, ['SECURITY_CRITICAL', 'ADVISORY'] as const),
        inputSchema: 'schema:in',
        outputSchema: 'schema:out',
        timeoutMs: randInt(rng, 100, 5000),
        sideEffectPolicy: 'NONE',
      }));

      const shuffled = [...descriptors].sort(() => rng() - 0.5);
      const planA = compilePlan(1, 'policy-v1', descriptors);
      const planB = compilePlan(1, 'policy-v1', shuffled);

      if (planA.planDigest !== planB.planDigest) {
        return { held: false, detail: 'the same descriptor set produced different digests depending on input order', counterexample: { descriptors, shuffled, planA, planB } };
      }
      if (planA.orderedDescriptors.map((d) => d.interceptorId).join(',') !== planB.orderedDescriptors.map((d) => d.interceptorId).join(',')) {
        return { held: false, detail: 'the same descriptor set produced a different order depending on input order', counterexample: { planA, planB } };
      }

      const withExtra = compilePlan(1, 'policy-v1', [...descriptors, { ...descriptors[0]!, interceptorId: `extra-${seed}` }]);
      if (withExtra.planDigest === planA.planDigest) {
        return { held: false, detail: 'adding a genuinely different descriptor did not change the digest', counterexample: { planA, withExtra } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/telemetry-is-not-authority',
    statement:
      'commitFencedObservation()\'s outcome — committed or not, and the stored Observation itself — is bit-for-bit identical whether or not an OperationalEnvelope is ever emitted, including when the sink always throws. safeEmit() never propagates a sink failure to its caller.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      function runScenario(emit: boolean) {
        const db = openInMemoryDatabase();
        const runSteps = new RunStepStore(db);
        const attempts = new ExecutionAttemptStore(db, runSteps);
        const observations = new ObservationStore(db);
        const events = new CampaignEventStore(db);
        const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' }, new Date(0));
        // Fixed executionAttemptId so both scenario runs (with/without a failing telemetry sink)
        // are otherwise byte-for-byte identical — the only thing allowed to differ.
        const attempt = leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, 'worker-a', 0, `attempt-${seed}`);

        if (emit) {
          const envelope = buildEnvelope('campaign-1', attempt);
          const throwingSink: EnvelopeSink = {
            emit: () => {
              throw new Error('telemetry backend unreachable');
            },
          };
          const emitResult = safeEmit(throwingSink, envelope);
          if (emitResult.emitted || emitResult.error === undefined) {
            throw new Error('law setup: expected safeEmit to report the sink failure without throwing');
          }
        }

        const observation = validObservation(`obs-${seed}`);
        const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(0).toISOString() });
        return commitFencedObservation(db, observations, events, attempts, { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' }, observation, eventInput);
      }

      let withoutTelemetry: ReturnType<typeof runScenario>;
      let withFailingTelemetry: ReturnType<typeof runScenario>;
      try {
        withoutTelemetry = runScenario(false);
        withFailingTelemetry = runScenario(true);
      } catch (err) {
        return { held: false, detail: `safeEmit propagated a sink failure: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (withoutTelemetry.committed !== withFailingTelemetry.committed) {
        return { held: false, detail: 'commit outcome differed depending on telemetry sink failure', counterexample: { withoutTelemetry, withFailingTelemetry } };
      }
      if (withoutTelemetry.committed && withFailingTelemetry.committed) {
        if (JSON.stringify(withoutTelemetry.commit.observation) !== JSON.stringify(withFailingTelemetry.commit.observation)) {
          return { held: false, detail: 'the committed Observation differed depending on telemetry sink failure', counterexample: { withoutTelemetry, withFailingTelemetry } };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/recovery-preserves-single-observation',
    statement:
      'After any number of interrupted-and-retried rounds on one RunStep — each an ambiguous EffectReceipt, a reconciliation, and a rejected stray duplicate on the now-terminal old attempt — exactly one Observation ever exists once the final attempt genuinely commits.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const rounds = randInt(rng, 0, 4);
      let scenario: ReturnType<typeof runRecoveryScenario>;
      try {
        scenario = runRecoveryScenario(seed, rounds);
      } catch (err) {
        return { held: false, detail: `scenario setup failed: ${err instanceof Error ? err.message : String(err)}`, counterexample: { rounds } };
      }
      if (!scenario.commit.committed) {
        return { held: false, detail: 'the final, current-generation attempt failed to commit', counterexample: { rounds, commit: scenario.commit } };
      }
      const all = scenario.observations.listByAssessmentRun('run-1');
      if (all.length !== 1) {
        return { held: false, detail: `expected exactly one Observation after ${rounds} recovery round(s), found ${all.length}`, counterexample: { rounds, all } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/replay-preserves-effect-resolution',
    statement:
      'After any number of interrupted-and-retried recovery rounds, exactly one CampaignEvent exists — retry/reconciliation noise never leaks into the event log — and two independent replays of it produce the identical CampaignWorld fingerprint.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const rounds = randInt(rng, 0, 4);
      let scenario: ReturnType<typeof runRecoveryScenario>;
      try {
        scenario = runRecoveryScenario(seed, rounds);
      } catch (err) {
        return { held: false, detail: `scenario setup failed: ${err instanceof Error ? err.message : String(err)}`, counterexample: { rounds } };
      }
      const allEvents = scenario.events.listByCampaign('campaign-1');
      if (allEvents.length !== 1) {
        return { held: false, detail: `expected exactly one CampaignEvent after ${rounds} recovery round(s), found ${allEvents.length}`, counterexample: { rounds } };
      }
      const replayA = replay(allEvents, 'campaign-1');
      const replayB = replay(allEvents, 'campaign-1');
      if (replayA.stoppedAt !== null || replayB.stoppedAt !== null) {
        return { held: false, detail: 'replay stopped early after a recovery scenario', counterexample: { replayA: replayA.stoppedAt, replayB: replayB.stoppedAt } };
      }
      if (fingerprint(replayA.world) !== fingerprint(replayB.world)) {
        return { held: false, detail: 'two replays of the same post-recovery event log produced different fingerprints', counterexample: { rounds } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/fenced-commit-is-a-single-transaction',
    statement:
      "commitFencedObservation() never leaves partial state: across a rejected bind, a full success, and a mid-commit failure (a malformed CampaignEvent, discovered only after the Observation insert already ran inside the same transaction), the Observation's existence, the CampaignEvent's existence, and the attempt's COMPLETED terminal state always agree — all three or none, never a subset. Audit finding: before this fix, the fencing check, the Observation/CampaignEvent insert, and markTerminal() were three separate points of atomicity, not one.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const observations = new ObservationStore(db);
      const events = new CampaignEventStore(db);

      const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' }, new Date(0));
      const attempt = leaseAndStartAttempt(runSteps, attempts, 'run-1', step.id, 'worker-a', 0);

      const scenario = pick(rng, ['reject', 'success', 'mid-failure'] as const);
      if (scenario === 'reject') {
        attempts.markTerminal(attempt.executionAttemptId, 'CANCELLED');
      }

      const obsId = `obs-${seed}`;
      const observation = validObservation(obsId);
      const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(0).toISOString() });
      const binding = { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' };

      let threw = false;
      let committed = false;
      try {
        const result = commitFencedObservation(
          db,
          observations,
          events,
          attempts,
          binding,
          observation,
          scenario === 'mid-failure' ? { ...eventInput, eventType: 'NotARealEventType' } : eventInput,
        );
        committed = result.committed;
      } catch {
        threw = true;
      }

      const observationExists = observations.listByAssessmentRun('run-1').length === 1;
      const eventExists = events.listByCampaign('campaign-1').length === 1;
      const attemptCompleted = attempts.get(attempt.executionAttemptId)?.terminalReason === 'COMPLETED';

      if (observationExists !== eventExists || eventExists !== attemptCompleted) {
        return {
          held: false,
          detail: 'Observation existence, CampaignEvent existence, and attempt COMPLETED state disagreed after commitFencedObservation()',
          counterexample: { scenario, threw, committed, observationExists, eventExists, attemptCompleted },
        };
      }
      if (scenario === 'success' && !attemptCompleted) {
        return { held: false, detail: 'the success scenario did not actually complete', counterexample: { scenario, threw, committed } };
      }
      if ((scenario === 'reject' || scenario === 'mid-failure') && attemptCompleted) {
        return { held: false, detail: `the ${scenario} scenario left the attempt COMPLETED anyway`, counterexample: { scenario, threw, committed } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/dispatch-admission-composes-authorization-and-concurrency',
    statement:
      "Audit finding #7: admitDispatch() composes evaluateAuthorization() and ConcurrencyScheduler.reserve() into one real admission gate, rtap/README.md's Phase 4.5.3/4.5.4 sections had repeatedly noted nothing did. Across random role/tenant/pre-existing-conflict combinations: an unauthorized principal is always rejected at the AUTHORIZATION stage and never reaches the concurrency stage at all (the reservation count never changes), and its denial is always recorded as a terminal AUTHORIZATION_DENIED attempt — a security event keeps its durable trace; an authorized request that conflicts with an existing reservation is always rejected at the CONCURRENCY stage, also without changing the reservation count (the conflicting holder is undisturbed and no phantom reservation is left behind); and a request that clears both gates always creates exactly one new reservation, correctly attributed to the real returned ExecutionAttempt (not a placeholder), whose terminalReason is null.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();

      const { step } = runSteps.enqueue('run-1', `key-${seed}`, {});
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 60_000 });

      const role = pick(rng, ['VIEWER', 'OPERATOR', 'ADMIN'] as const);
      const crossTenant = randBool(rng, 0.3);
      const preConflict = randBool(rng, 0.3);

      if (preConflict) {
        scheduler.reserve({
          campaignId: 'campaign-1',
          executionAttemptId: 'holder',
          declarations: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        });
      }
      const before = scheduler.activeReservations().length;

      const declarations: ConcurrencyDeclaration[] = [
        { concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null },
      ];
      const request: DispatchGuardRequest = {
        authorization: {
          principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: [role] },
          resourceTenantId: crossTenant ? 'tenant-b' : 'tenant-a',
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
        },
        concurrency: declarations,
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
      };

      const result = admitDispatch(authProvider, scheduler, attempts, request);
      const after = scheduler.activeReservations().length;
      const shouldBeAuthorized = role !== 'VIEWER' && !crossTenant;

      if (!shouldBeAuthorized) {
        if (result.admitted) return { held: false, detail: 'an unauthorized principal was admitted', counterexample: { role, crossTenant, result } };
        if (result.stage !== 'AUTHORIZATION') return { held: false, detail: 'an unauthorized principal was rejected at the wrong stage', counterexample: { role, crossTenant, result } };
        if (after !== before) return { held: false, detail: 'an authorization rejection still changed the reservation count — the concurrency stage should never have been reached', counterexample: { before, after, result } };
        if (result.attempt.terminalReason !== 'AUTHORIZATION_DENIED') return { held: false, detail: "attempt.terminalReason did not reflect the authorization rejection", counterexample: result };
        return { held: true };
      }

      if (preConflict) {
        if (result.admitted) return { held: false, detail: 'admitted despite a conflicting reservation already held', counterexample: { result } };
        if (result.stage !== 'CONCURRENCY') return { held: false, detail: 'rejected at the wrong stage despite a real conflict', counterexample: { result } };
        if (after !== before) return { held: false, detail: 'a concurrency rejection still changed the reservation count', counterexample: { before, after, result } };
        if (result.attempt !== null) return { held: false, detail: 'back-pressure wrote an ExecutionAttempt record', counterexample: result };
        return { held: true };
      }

      if (!result.admitted) return { held: false, detail: 'an authorized, non-conflicting request was rejected', counterexample: { role, crossTenant, preConflict, result } };
      if (after !== before + 1) return { held: false, detail: 'admission did not create exactly one new reservation', counterexample: { before, after, result } };
      if (result.attempt.terminalReason !== null) return { held: false, detail: 'an admitted attempt was already terminal', counterexample: result };
      const active = scheduler.activeReservations().find((r) => r.reservationId === result.reservationId);
      if (!active || active.executionAttemptId !== result.attempt.executionAttemptId) {
        return { held: false, detail: 'the reservation is not attributed to the real admitted attempt', counterexample: { active, attempt: result.attempt } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.execution/rollback-disables-authorization-not-fencing',
    statement:
      "§15 criterion 14's rollback drill: admitDispatch()'s HardeningConfig.authorizationEnforced=false genuinely disables the authorization check — a request that would be denied under HARDENING_ENFORCED (for either a role-based or a cross-tenant denial) is admitted when bypassed, and carries no fabricated AuthorizationReceipt for a decision that was never made. But fencing (execution-attempt-store.ts's bindNativeResult(), Phase 4.5.1, which never receives this config) is byte-for-byte unaffected: an attempt admitted while bypassed is rejected as STALE_LEASE_RESULT once its lease is superseded, exactly as one admitted while enforced would be — disabling hardening weakens authorization, not fencing.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();

      // Part 1: bypass genuinely disables authorization — for either rejection reason,
      // not just one — and never fabricates a receipt for a decision that was skipped.
      const denialMode = pick(rng, ['viewer', 'cross-tenant'] as const);
      const deniedPrincipal =
        denialMode === 'viewer'
          ? { subjectId: 'subject-1', tenantId: 'tenant-a', roles: ['VIEWER'] as const }
          : { subjectId: 'subject-1', tenantId: 'tenant-b', roles: ['OPERATOR'] as const };

      const { step: denyStep } = runSteps.enqueue('run-1', `rollback-deny-${seed}`, {});
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 60_000 });

      const denyRequest: DispatchGuardRequest = {
        authorization: {
          principal: deniedPrincipal,
          resourceTenantId: 'tenant-a',
          campaignId: 'campaign-1',
          assessmentRunId: 'run-1',
          runStepId: denyStep.id,
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
        concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: [`target-${seed}`], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        attemptStart: { assessmentRunId: 'run-1', runStepId: denyStep.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-deny-${seed}` },
      };

      const enforcedDenial = admitDispatch(authProvider, scheduler, attempts, denyRequest, undefined, HARDENING_ENFORCED);
      if (enforcedDenial.admitted) {
        return { held: false, detail: 'a principal that should be denied was admitted under HARDENING_ENFORCED', counterexample: { denialMode, enforcedDenial } };
      }
      if (enforcedDenial.stage !== 'AUTHORIZATION') {
        return { held: false, detail: 'denial happened at the wrong stage', counterexample: { denialMode, enforcedDenial } };
      }

      const bypassAdmission = admitDispatch(authProvider, scheduler, attempts, denyRequest, undefined, { authorizationEnforced: false });
      if (!bypassAdmission.admitted) {
        return { held: false, detail: 'the same principal, same request, was still denied with authorizationEnforced:false — the flag is not disabling anything', counterexample: { denialMode, bypassAdmission } };
      }
      if (bypassAdmission.authorizationReceipt !== null) {
        return { held: false, detail: 'a bypassed admission fabricated an authorizationReceipt for a decision that was never made', counterexample: bypassAdmission };
      }

      // Part 2: fencing is identical regardless of which hardening mode admitted the
      // attempt — randomized per trial so both modes get real coverage across seeds.
      const mode = pick(rng, ['enforced', 'bypass'] as const);
      const hardening = mode === 'enforced' ? HARDENING_ENFORCED : { authorizationEnforced: false };
      const authorizedPrincipal = { subjectId: 'subject-2', tenantId: 'tenant-a', roles: ['OPERATOR'] as const };

      const now0 = new Date(0);
      const { step: fenceStep } = runSteps.enqueue('run-2', `rollback-fence-${seed}`, {});
      runSteps.lease('run-2', { owner: 'w1', leaseDurationMs: LEASE_DURATION_MS, now: () => now0 });

      const fenceRequest: DispatchGuardRequest = {
        authorization: {
          principal: authorizedPrincipal,
          resourceTenantId: 'tenant-a',
          campaignId: 'campaign-2',
          assessmentRunId: 'run-2',
          runStepId: fenceStep.id,
          operationFamily: 'llm-attack',
          targetSnapshotRef: 'target-snapshot-2',
          adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' },
          declaredCapabilityDigest: 'digest-1',
          expectedCapabilityDigest: 'digest-1',
          policyRevision: 'policy-v1',
          sandboxProfileRef: 'sandbox-1',
          egressPolicyRef: 'egress-1',
          receiptDurationMs: 60_000,
        },
        concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: [`fence-target-${seed}`], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        attemptStart: { assessmentRunId: 'run-2', runStepId: fenceStep.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-fence-${seed}` },
      };

      const fenceAdmission = admitDispatch(authProvider, scheduler, attempts, fenceRequest, now0, hardening);
      if (!fenceAdmission.admitted) {
        return { held: false, detail: 'an authorized request was refused during the fencing half of the drill', counterexample: { mode, fenceAdmission } };
      }

      // Supersede the lease: a second lease() call after expiry bumps leaseGeneration,
      // exactly as a competing worker taking over an abandoned step would.
      const now1 = new Date(LEASE_DURATION_MS + 1);
      runSteps.lease('run-2', { owner: 'w2', leaseDurationMs: LEASE_DURATION_MS, now: () => now1 });

      const bindResult = attempts.bindNativeResult({ runStepId: fenceStep.id, executionAttemptId: fenceAdmission.attempt.executionAttemptId, nativeResultRef: 'native-ref-1' }, now1);
      if (bindResult.permitted) {
        return { held: false, detail: 'a result from a superseded lease was permitted — fencing was weakened', counterexample: { mode, bindResult } };
      }
      if (bindResult.reason !== 'STALE_LEASE_RESULT') {
        return { held: false, detail: 'fencing rejected the result for the wrong reason', counterexample: { mode, bindResult } };
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/ask-is-durable-and-resolves-exactly-once',
    statement:
      "грань №12 (Грани Arch_claude): an ApprovalPolicy that requires approval refuses admission at stage ASK — attempt: null, the same no-execution-record treatment as CONCURRENCY back-pressure — and creates exactly one durable PendingApproval per RunStep no matter how many times admission is retried while it is still pending. Once resolved (APPROVED or DENIED), the next admitDispatch() call for that RunStep reflects the decision: normal admission with a real reservation, or a durable AUTHORIZATION_DENIED attempt. A second resolve() racing the first after it already won never overturns it — exactly one decision survives, and the loser is told so, not given a false success.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();
      const approvals = new PendingApprovalStore(db);
      const alwaysAsk: ApprovalPolicy = { requiresApproval: () => true };
      const gate: ApprovalGate = { policy: alwaysAsk, approvals };

      const { step } = runSteps.enqueue('run-1', `ask-${seed}`, {});
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 60_000 });

      const request: DispatchGuardRequest = {
        authorization: {
          principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: ['OPERATOR'] },
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
        },
        concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: [`ask-target-${seed}`], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `ask-req-${seed}` },
      };

      // Retry admission a random number of times while the ask is still pending —
      // every retry must see the exact same approvalId, never mint a second ask.
      const retries = randInt(rng, 1, 4);
      let approvalId: string | undefined;
      for (let i = 0; i < retries; i += 1) {
        const result = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
        if (result.admitted || result.stage !== 'ASK') {
          return { held: false, detail: `retry ${i} was not refused at stage ASK`, counterexample: { seed, i, result } };
        }
        if (approvalId === undefined) {
          approvalId = result.approvalId;
        } else if (result.approvalId !== approvalId) {
          return { held: false, detail: 'a retry while still pending minted a second ask', counterexample: { seed, i, approvalId, got: result.approvalId } };
        }
      }
      if (approvalId === undefined) return { held: false, detail: 'no retries ran', counterexample: { seed, retries } };

      const attemptCount = (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as { n: number }).n;
      if (attemptCount !== 0) {
        return { held: false, detail: 'an ASK refusal wrote an execution record', counterexample: { seed, attemptCount } };
      }

      const finalDecision = pick(rng, ['APPROVED', 'DENIED'] as const);
      const firstResolve = approvals.resolve(approvalId, finalDecision, 'operator-1');
      if (!firstResolve.resolved) {
        return { held: false, detail: 'the first resolve() for a freshly-created ask did not win', counterexample: { seed, approvalId, firstResolve } };
      }

      // A second resolver races the first with the opposite decision, immediately after.
      const opposite = finalDecision === 'APPROVED' ? 'DENIED' : 'APPROVED';
      const secondResolve = approvals.resolve(approvalId, opposite, 'operator-2');
      if (secondResolve.resolved) {
        return { held: false, detail: 'a second resolve() for an already-decided approval won the race', counterexample: { seed, approvalId, secondResolve } };
      }
      if (secondResolve.reason !== 'ALREADY_DECIDED' || secondResolve.approval.decision !== finalDecision) {
        return { held: false, detail: 'the losing resolver was not told the decision that actually won', counterexample: { seed, finalDecision, secondResolve } };
      }

      const retried = admitDispatch(authProvider, scheduler, attempts, request, undefined, HARDENING_ENFORCED, gate);
      if (finalDecision === 'APPROVED') {
        if (!retried.admitted) {
          return { held: false, detail: 'an approved ask was still refused on retry', counterexample: { seed, retried } };
        }
        if (retried.attempt.terminalReason !== null) {
          return { held: false, detail: 'an admitted-after-approval attempt was already terminal', counterexample: retried };
        }
        if (scheduler.activeReservations().length !== 1) {
          return { held: false, detail: 'approval did not result in exactly one reservation', counterexample: { seed, reservations: scheduler.activeReservations() } };
        }
      } else {
        if (retried.admitted) {
          return { held: false, detail: 'a denied ask was admitted on retry', counterexample: { seed, retried } };
        }
        if (retried.stage !== 'AUTHORIZATION' || retried.attempt.terminalReason !== 'AUTHORIZATION_DENIED') {
          return { held: false, detail: 'a denied ask did not durably record AUTHORIZATION_DENIED on retry', counterexample: { seed, retried } };
        }
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/backpressure-is-not-an-execution-record',
    statement:
      "ARCH_CLAUDE_TRANSFER.md §2.2: a concurrency refusal is back-pressure, not a failed execution, and writes nothing to execution_attempts. Over N contested requests against a barrier already held, the execution_attempts row count is completely unchanged — not merely unchanged in the returned value — so CampaignHistoryView's attempt counts, and therefore enumerateEligibleCandidates()'s eligibility gate, cannot be inflated by contention. TARGET_UNAVAILABLE is never written by back-pressure at all. An authorization denial, by contrast, always does write its terminal attempt row: a security event keeps its durable trace, and the two rejection branches are deliberately asymmetric.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();
      const countAttempts = () => (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts`).get() as unknown as { n: number }).n;

      const { step } = runSteps.enqueue('run-1', `key-${seed}`, { probeId: 'probe-1' }, new Date(0));
      const blockingClass = pick(rng, ['TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE'] as const);
      const contested = randInt(rng, 1, 5);

      const buildRequest = (role: 'VIEWER' | 'OPERATOR', i: number): DispatchGuardRequest => ({
        authorization: {
          principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: [role] },
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
        },
        concurrency: [{ concurrencyClass: blockingClass, resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}-${i}` },
      });

      // One holder takes the barrier legitimately.
      const holder = admitDispatch(authProvider, scheduler, attempts, buildRequest('OPERATOR', 0));
      if (!holder.admitted) return { held: false, detail: 'law setup: the first, uncontested request was not admitted', counterexample: holder };

      const afterHolder = countAttempts();
      if (afterHolder !== 1) return { held: false, detail: 'an admitted request did not create exactly one attempt row', counterexample: { afterHolder } };

      // Every contested request must be refused without leaving a trace.
      for (let i = 0; i < contested; i += 1) {
        const refused = admitDispatch(authProvider, scheduler, attempts, buildRequest('OPERATOR', i + 1));
        if (refused.admitted) return { held: false, detail: 'a contested request was admitted while the barrier was held', counterexample: refused };
        if (refused.stage !== 'CONCURRENCY') return { held: false, detail: 'a contested request was refused at the wrong stage', counterexample: refused };
        if (refused.attempt !== null) return { held: false, detail: 'back-pressure returned an ExecutionAttempt', counterexample: refused };
      }

      const afterContention = countAttempts();
      if (afterContention !== afterHolder) {
        return {
          held: false,
          detail: `${contested} contested requests wrote ${afterContention - afterHolder} execution_attempts rows — contention inflated the execution journal`,
          counterexample: { blockingClass, contested, afterHolder, afterContention },
        };
      }
      const fabricated = (db.prepare(`SELECT COUNT(*) AS n FROM execution_attempts WHERE terminal_reason = 'TARGET_UNAVAILABLE'`).get() as unknown as { n: number }).n;
      if (fabricated !== 0) return { held: false, detail: 'back-pressure fabricated a TARGET_UNAVAILABLE record', counterexample: { fabricated } };

      // The asymmetry is deliberate: an authorization denial still records itself.
      const denied = admitDispatch(authProvider, scheduler, attempts, buildRequest('VIEWER', 99));
      if (denied.admitted) return { held: false, detail: 'a VIEWER was admitted for run-step:dispatch', counterexample: denied };
      if (denied.stage !== 'AUTHORIZATION') return { held: false, detail: 'a VIEWER was refused at the wrong stage', counterexample: denied };
      if (denied.attempt.terminalReason !== 'AUTHORIZATION_DENIED') {
        return { held: false, detail: 'an authorization denial did not record a terminal AUTHORIZATION_DENIED attempt', counterexample: denied };
      }
      if (countAttempts() !== afterHolder + 1) {
        return { held: false, detail: 'an authorization denial did not write exactly one attempt row', counterexample: { expected: afterHolder + 1, actual: countAttempts() } };
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/settlement-releases-what-admission-acquired',
    statement:
      "settleAttempt() disposes of the scheduler barrier admitDispatch() acquired, for every TerminalReason, in exactly one direction: UNKNOWN_EFFECT_OUTCOME retains it (§6 — the effect may still be genuinely in flight, so the target stays barred until an operator resolves it out of band), and every other terminal reason releases it. After any settlement, no attempt is left terminal-but-still-holding a barrier except that one sanctioned case, and the retained case is genuinely still held rather than quietly released. Settling twice is refused outright, so a barrier can never be released against a resolution someone else already decided.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();

      const ALL_REASONS: readonly TerminalReason[] = [
        'COMPLETED',
        'CANCELLED',
        'TIMED_OUT_BEFORE_EFFECT',
        'AUTHORIZATION_DENIED',
        'CAPABILITY_UNSUPPORTED',
        'TARGET_UNAVAILABLE',
        'FAILED_BEFORE_EFFECT',
        'UNKNOWN_EFFECT_OUTCOME',
        'NORMALIZATION_FAILED',
        'STALE_LEASE_RESULT',
        'OBSERVATION_COMMITTED',
      ];
      const reason = pick(rng, ALL_REASONS);
      const shouldRetain = reason === 'UNKNOWN_EFFECT_OUTCOME';
      // A settled attempt that never held a barrier at all must not be mistaken for
      // a leak in either direction, so exercise both shapes.
      const withBarrier = randBool(rng, 0.8);
      const concurrencyClass = pick(rng, ['TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE', 'READ_ONLY_PARALLEL'] as const);

      const { step } = runSteps.enqueue('run-1', `key-${seed}`, { probeId: 'probe-1' }, new Date(0));

      let executionAttemptId: string;
      if (withBarrier) {
        const request: DispatchGuardRequest = {
          authorization: {
            principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: ['OPERATOR'] },
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
          },
          concurrency: [{ concurrencyClass, resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
          attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
        };
        const admitted = admitDispatch(authProvider, scheduler, attempts, request);
        if (!admitted.admitted) return { held: false, detail: 'law setup: a clean authorized request was not admitted', counterexample: admitted };
        executionAttemptId = admitted.attempt.executionAttemptId;
        if (scheduler.activeReservationForAttempt(executionAttemptId) === null) {
          return { held: false, detail: 'law setup: admission reported success but left no active reservation for the attempt' };
        }
      } else {
        executionAttemptId = attempts.start(
          { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
          new Date(0),
        ).executionAttemptId;
      }

      const settled = settleAttempt(attempts, scheduler, executionAttemptId, reason, new Date(1000));

      if (settled.attempt.terminalReason !== reason) {
        return { held: false, detail: 'settlement did not record the terminal reason it was given', counterexample: { reason, attempt: settled.attempt } };
      }

      const expectedKind = !withBarrier ? 'NONE' : shouldRetain ? 'RETAINED' : 'RELEASED';
      if (settled.reservation.kind !== expectedKind) {
        return {
          held: false,
          detail: `expected reservation disposition ${expectedKind}, got ${settled.reservation.kind}`,
          counterexample: { reason, withBarrier, concurrencyClass, disposition: settled.reservation },
        };
      }

      // The disposition must match reality in the durable table, not merely be reported.
      const stillHeld = scheduler.activeReservationForAttempt(executionAttemptId);
      if (shouldRetain && withBarrier && stillHeld === null) {
        return { held: false, detail: 'UNKNOWN_EFFECT_OUTCOME reported RETAINED but the barrier was actually released', counterexample: { reason, disposition: settled.reservation } };
      }
      if (!shouldRetain && stillHeld !== null) {
        return { held: false, detail: `a ${reason} settlement left its barrier held`, counterexample: { reason, stillHeld } };
      }

      // The global property, stated as the leak it prevents: no terminal attempt is
      // still holding a barrier, with UNKNOWN_EFFECT_OUTCOME as the sole exception.
      const leaked = scheduler
        .activeReservations()
        .map((r) => ({ reservation: r, attempt: attempts.get(r.executionAttemptId) }))
        .filter((x) => x.attempt !== null && x.attempt.terminalReason !== null && x.attempt.terminalReason !== 'UNKNOWN_EFFECT_OUTCOME');
      if (leaked.length > 0) {
        return { held: false, detail: 'a terminal attempt is still holding a scheduler reservation', counterexample: leaked };
      }

      // Exactly one settlement: the second is refused, so it cannot re-decide (or
      // undo) the barrier's fate.
      let secondSettlementRefused = false;
      try {
        settleAttempt(attempts, scheduler, executionAttemptId, reason, new Date(2000));
      } catch {
        secondSettlementRefused = true;
      }
      if (!secondSettlementRefused) {
        return { held: false, detail: 'an already-settled attempt was settled a second time', counterexample: { reason, executionAttemptId } };
      }

      return { held: true };
    },
  },
  // грань №19 — admission-before-lease: a worker-level concurrency precheck so a
  // step that would only be CONCURRENCY-refused by admitDispatch() anyway never
  // pays lease()'s lease_generation bump for nothing.
  {
    id: 'redteam.execution/peek-agrees-with-lease',
    statement:
      'RunStepStore.peekLeasable() always identifies the exact same candidate RunStepStore.lease() itself would then claim — never a different one, and never one lease() would reject — across random populations of PENDING, live-leased, and expired-leased steps at random creation times. excludeIds never returns the excluded id, and whatever peekLeasable() returns after excluding some ids remains genuinely leasable via a targeted lease({stepId}).',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const count = randInt(rng, 1, 8);
      const now = new Date(100_000);

      for (let i = 0; i < count; i += 1) {
        const createdAt = new Date(randInt(rng, 0, 99_000));
        const { step } = runSteps.enqueue('run-1', `key-${i}`, {}, createdAt);
        const state = pick(rng, ['pending', 'live-lease', 'expired-lease'] as const);
        if (state === 'live-lease') {
          runSteps.lease('run-1', { owner: 'holder', leaseDurationMs: 1_000_000, now: () => createdAt, stepId: step.id });
        } else if (state === 'expired-lease') {
          runSteps.lease('run-1', { owner: 'holder', leaseDurationMs: 1, now: () => createdAt, stepId: step.id });
        }
      }

      const peeked = runSteps.peekLeasable('run-1', { now: () => now });
      const excludedPeek = peeked ? runSteps.peekLeasable('run-1', { excludeIds: [peeked.id], now: () => now }) : null;
      if (excludedPeek && excludedPeek.id === peeked!.id) {
        return { held: false, detail: 'excludeIds did not remove the excluded candidate', counterexample: { peeked, excludedPeek } };
      }

      const leased = runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: 60_000, now: () => now });
      if ((peeked === null) !== (leased === null)) {
        return { held: false, detail: 'peekLeasable() and lease() disagreed on whether anything is leasable', counterexample: { peeked, leased } };
      }
      if (peeked && leased && peeked.id !== leased.id) {
        return { held: false, detail: 'peekLeasable() and lease() picked different candidates', counterexample: { peeked, leased } };
      }

      if (excludedPeek) {
        const targeted = runSteps.lease('run-1', { owner: 'worker-b', leaseDurationMs: 60_000, now: () => now, stepId: excludedPeek.id });
        if (!targeted) {
          return { held: false, detail: 'a candidate peekLeasable() returned after exclusion was not actually leasable via a targeted lease()', counterexample: { excludedPeek } };
        }
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/probe-agrees-with-reserve',
    statement:
      "ConcurrencyScheduler.probe() and reserve() always agree: probe() reports wouldReserve:true iff an identical reserve() call would actually succeed, and reports the identical reason and conflicting set on a refusal — across random populations of pre-existing active reservations and random request declarations. probe() never creates a reservation of its own.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
      const classes: ConcurrencyClass[] = ['READ_ONLY_PARALLEL', 'TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE'];
      const resourcePool = ['r1', 'r2', 'r3'];

      const existing = randInt(rng, 0, 4);
      for (let i = 0; i < existing; i += 1) {
        scheduler.reserve({
          campaignId: 'campaign-1',
          executionAttemptId: `holder-${i}`,
          declarations: [{ concurrencyClass: pick(rng, classes), resourceKeys: [pick(rng, resourcePool)], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        });
      }

      const before = scheduler.activeReservations().length;
      const request = {
        campaignId: 'campaign-1',
        declarations: [{ concurrencyClass: pick(rng, classes), resourceKeys: [pick(rng, resourcePool)], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
      };

      const probeResult = scheduler.probe(request);
      const afterProbe = scheduler.activeReservations().length;
      if (afterProbe !== before) {
        return { held: false, detail: 'probe() changed the reservation count — it must be read-only', counterexample: { before, afterProbe } };
      }

      const reserveResult = scheduler.reserve({ ...request, executionAttemptId: 'probed-attempt' });

      if (probeResult.wouldReserve !== reserveResult.reserved) {
        return { held: false, detail: 'probe() and reserve() disagreed on whether the request would succeed', counterexample: { probeResult, reserveResult } };
      }
      if (!probeResult.wouldReserve && !reserveResult.reserved) {
        if (probeResult.reason !== reserveResult.reason) {
          return { held: false, detail: 'probe() and reserve() disagreed on the refusal reason', counterexample: { probeResult, reserveResult } };
        }
        const probedIds = probeResult.conflicting.map((r) => r.reservationId).sort();
        const reservedIds = reserveResult.conflicting.map((r) => r.reservationId).sort();
        if (JSON.stringify(probedIds) !== JSON.stringify(reservedIds)) {
          return { held: false, detail: 'probe() and reserve() disagreed on the conflicting set', counterexample: { probeResult, reserveResult } };
        }
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/concurrency-precheck-skips-lease-generation-bump',
    statement:
      "грань №19's actual fix, proven end-to-end on identical scenarios: given a candidate RunStep whose declared concurrency would be CONFLICT-refused by an already-held reservation, the old lease()-first strategy (call RunStepStore.lease(), then admitDispatch()) always bumps lease_generation even though admission is refused — but the new peek -> probeConcurrency -> targeted-lease-only-if-clear strategy (leaseWithConcurrencyPrecheck()) leaves lease_generation completely untouched, because the concurrency-blocked candidate is never leased at all.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const authProvider = new RoleBasedAuthorizationProvider();
      const declaration = { concurrencyClass: 'TARGET_SERIAL' as const, resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null };

      function buildRequest(runStepId: string): DispatchGuardRequest {
        return {
          authorization: {
            principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: ['OPERATOR'] },
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
          concurrency: [declaration],
          attemptStart: { assessmentRunId: 'run-1', runStepId, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
        };
      }

      // Old strategy: lease first, admit second.
      const oldDb = openInMemoryDatabase();
      const oldRunSteps = new RunStepStore(oldDb);
      const oldAttempts = new ExecutionAttemptStore(oldDb, oldRunSteps);
      const oldScheduler = new ConcurrencyScheduler(oldDb);
      oldScheduler.reserve({ campaignId: 'campaign-1', executionAttemptId: 'holder', declarations: [declaration] });
      const { step: oldStep } = oldRunSteps.enqueue('run-1', `key-${seed}`, {}, new Date(0), { campaignId: 'campaign-1', targetId: 'target-1' });

      const oldLeased = oldRunSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: 60_000 });
      if (!oldLeased) return { held: false, detail: 'law setup: old-strategy lease() unexpectedly found nothing to claim' };
      const oldAdmission = admitDispatch(authProvider, oldScheduler, oldAttempts, buildRequest(oldLeased.id));
      if (oldAdmission.admitted || oldAdmission.stage !== 'CONCURRENCY') {
        return { held: false, detail: 'law setup: expected the old strategy to be CONCURRENCY-refused', counterexample: oldAdmission };
      }
      const oldAfter = oldRunSteps.get(oldStep.id);

      // New strategy: peek, probe, lease only if clear.
      const newDb = openInMemoryDatabase();
      const newRunSteps = new RunStepStore(newDb);
      const newScheduler = new ConcurrencyScheduler(newDb);
      newScheduler.reserve({ campaignId: 'campaign-1', executionAttemptId: 'holder', declarations: [declaration] });
      const { step: newStep } = newRunSteps.enqueue('run-1', `key-${seed}`, {}, new Date(0), { campaignId: 'campaign-1', targetId: 'target-1' });

      const candidate = newRunSteps.peekLeasable('run-1');
      if (!candidate) return { held: false, detail: 'law setup: new-strategy peekLeasable() unexpectedly found nothing' };
      const precheck = leaseWithConcurrencyPrecheck(newRunSteps, newScheduler, 'run-1', candidate.id, buildRequest(candidate.id), { owner: 'worker-a', leaseDurationMs: 60_000 });
      if (precheck.outcome !== 'BLOCKED') {
        return { held: false, detail: 'law setup: expected the new strategy to be BLOCKED by the same conflict', counterexample: precheck };
      }
      const newAfter = newRunSteps.get(newStep.id);

      if (!oldAfter || !newAfter) return { held: false, detail: 'law setup: a step vanished' };
      if (oldAfter.leaseGeneration === 0) {
        return { held: false, detail: 'law setup: the old strategy did not actually bump lease_generation — scenario is not exercising the bug', counterexample: oldAfter };
      }
      if (newAfter.leaseGeneration !== 0) {
        return { held: false, detail: 'the new peek/probe strategy still bumped lease_generation on a foreseeable CONCURRENCY refusal', counterexample: { oldAfter, newAfter } };
      }
      if (newAfter.status !== 'PENDING') {
        return { held: false, detail: 'the new strategy left the concurrency-blocked step in a non-PENDING status', counterexample: newAfter };
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/authorize-not-called-during-precheck',
    statement:
      "leaseWithConcurrencyPrecheck()'s concurrency-only precheck never touches authorization: AuthorizationProvider.authorize() is called exactly 0 times while a candidate is being peeked and concurrency-probed, and exactly 1 time when the real admitDispatch() call afterward actually admits it — proving грань №19's precheck cannot silently double an audit log the way a generic authorization precheck would (see probeConcurrency()'s doc comment in dispatch.ts).",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const spy = new SpyAuthorizationProvider(new RoleBasedAuthorizationProvider());
      const role = pick(rng, ['OPERATOR', 'ADMIN'] as const);
      const concurrencyClass = pick(rng, ['TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE'] as const);

      const { step } = runSteps.enqueue('run-1', `key-${seed}`, {}, new Date(0), { campaignId: 'campaign-1', targetId: 'target-1' });
      const request: DispatchGuardRequest = {
        authorization: {
          principal: { subjectId: 'subject-1', tenantId: 'tenant-a', roles: [role] },
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
        },
        concurrency: [{ concurrencyClass, resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
      };

      const candidate = runSteps.peekLeasable('run-1', { now: () => new Date(0) });
      if (!candidate) return { held: false, detail: 'law setup: nothing to peek' };
      const callsAfterPeek = spy.calls;
      if (callsAfterPeek !== 0) return { held: false, detail: 'peekLeasable() called authorize()', counterexample: { calls: callsAfterPeek } };

      const precheck = leaseWithConcurrencyPrecheck(runSteps, scheduler, 'run-1', candidate.id, request, { owner: 'worker-a', leaseDurationMs: 60_000, now: () => new Date(0) });
      const callsAfterPrecheck = spy.calls;
      if (callsAfterPrecheck !== 0) return { held: false, detail: 'the concurrency precheck called authorize()', counterexample: { calls: callsAfterPrecheck, precheck } };
      if (precheck.outcome !== 'LEASED') return { held: false, detail: 'law setup: expected an uncontested precheck to lease', counterexample: precheck };

      const admission = admitDispatch(spy, scheduler, attempts, request, new Date(0));
      const callsAfterAdmission = spy.calls;
      if (callsAfterAdmission !== 1) return { held: false, detail: 'the real admission did not call authorize() exactly once', counterexample: { calls: callsAfterAdmission, admission } };
      if (!admission.admitted) return { held: false, detail: 'law setup: expected the real admission to succeed', counterexample: admission };

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/authorization-and-ask-still-bump-lease-generation',
    statement:
      "грань №19's precheck is concurrency-only by design (see probeConcurrency()'s doc comment for why AUTHORIZATION/ASK have no cheap equivalent): a candidate that clears the concurrency precheck, gets leased, and is then refused by the real admitDispatch() on AUTHORIZATION or ASK still bumps lease_generation exactly as it did before this fix — an explicit, accepted residual gap, not a silently-widened or silently-forgotten one.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);
      const scheduler = new ConcurrencyScheduler(db);
      const authProvider = new RoleBasedAuthorizationProvider();
      const approvals = new PendingApprovalStore(db);

      const refusalMode = pick(rng, ['authorization', 'ask'] as const);
      const gate: ApprovalGate | undefined = refusalMode === 'ask' ? { policy: { requiresApproval: () => true }, approvals } : undefined;
      const principal =
        refusalMode === 'authorization'
          ? { subjectId: 'subject-1', tenantId: 'tenant-a', roles: ['VIEWER'] as const }
          : { subjectId: 'subject-1', tenantId: 'tenant-a', roles: ['OPERATOR'] as const };

      const { step } = runSteps.enqueue('run-1', `key-${seed}`, {}, new Date(0), { campaignId: 'campaign-1', targetId: 'target-1' });
      const request: DispatchGuardRequest = {
        authorization: {
          principal,
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
        },
        concurrency: [{ concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null }],
        attemptStart: { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
      };

      const candidate = runSteps.peekLeasable('run-1', { now: () => new Date(0) });
      if (!candidate) return { held: false, detail: 'law setup: nothing to peek' };

      const precheck = leaseWithConcurrencyPrecheck(runSteps, scheduler, 'run-1', candidate.id, request, { owner: 'worker-a', leaseDurationMs: 60_000, now: () => new Date(0) });
      if (precheck.outcome !== 'LEASED') {
        return { held: false, detail: 'law setup: expected an uncontested-on-concurrency candidate to be leased by the precheck', counterexample: precheck };
      }
      if (precheck.step.leaseGeneration !== 1) {
        return { held: false, detail: 'law setup: the precheck-driven lease did not bump lease_generation to 1', counterexample: precheck };
      }

      const admission = admitDispatch(authProvider, scheduler, attempts, request, new Date(0), undefined, gate);
      if (admission.admitted) {
        return { held: false, detail: `law setup: expected the real admission to be refused (${refusalMode})`, counterexample: admission };
      }
      if (refusalMode === 'authorization' && admission.stage !== 'AUTHORIZATION') {
        return { held: false, detail: 'law setup: expected an AUTHORIZATION refusal', counterexample: admission };
      }
      if (refusalMode === 'ask' && admission.stage !== 'ASK') {
        return { held: false, detail: 'law setup: expected an ASK refusal', counterexample: admission };
      }

      const after = runSteps.get(step.id);
      if (!after || after.leaseGeneration !== 1) {
        return {
          held: false,
          detail: `${refusalMode} refusal changed lease_generation from the value the precheck-driven lease set — the residual-gap statement no longer matches reality`,
          counterexample: after,
        };
      }
      return { held: true };
    },
  },
];
