import { randomUUID } from 'node:crypto';
import type { AuthorizationProvider } from '../authz/types.js';
import { evaluateAuthorization, type AuthorizationReceipt, type AuthorizationRejectionReason, type AuthorizeEffectRequest } from './authorization.js';
import type { ConcurrencyDeclaration } from './concurrency.js';
import { strictestClass } from './concurrency.js';
import type { ConcurrencyReservation, ConcurrencyScheduler, ReservationRejectionReason } from './concurrency-scheduler.js';
import type { ExecutionAttemptStore } from './execution-attempt-store.js';
import type { ExecutionAttempt, StartAttemptInput } from './types.js';
import type { PendingApprovalStore } from './approval-store.js';

export interface DispatchGuardRequest {
  readonly authorization: AuthorizeEffectRequest;
  readonly concurrency: readonly ConcurrencyDeclaration[];
  readonly attemptStart: Omit<StartAttemptInput, 'concurrencyClass'>;
}

/**
 * §15 criterion 14's "hardening feature flag" — named for what it actually gates,
 * not left generic. `authorizationEnforced: false` skips only `evaluateAuthorization()`
 * (audit finding #7's authorization half of the composed admission gate); concurrency
 * reservation below is unconditional either way, and fencing
 * (`execution-attempt-store.ts`'s `bindNativeResult()`, Phase 4.5.1) does not accept
 * this config at all — there is no code path by which disabling it could reach fencing.
 * `HARDENING_ENFORCED` is the only value any real caller uses; nothing in `worker/`
 * or any production path constructs a disabled one — this exists to make the rollback
 * drill (`redteam.execution/rollback-disables-authorization-not-fencing`) provable,
 * not to give an operator a working bypass switch.
 */
export interface HardeningConfig {
  readonly authorizationEnforced: boolean;
}

export const HARDENING_ENFORCED: HardeningConfig = { authorizationEnforced: true };

/**
 * грань №12 (`Грани Arch_claude`) — "ask," adapted to RTAP's own architecture instead
 * of transplanted whole: the original idea models an unresolved decision as an
 * in-memory suspended `Promise` sitting in the call stack. That doesn't fit a system
 * built entirely around durable, crash-recoverable state — an in-memory Promise
 * would not survive a worker restart, which every other mechanism in this repo goes
 * out of its way to guarantee. RTAP already has the right native pattern: CONCURRENCY
 * back-pressure below already leaves a RunStep re-leasable rather than blocking
 * anything in-process. `requiresApproval()` is a pure, synchronous predicate — no
 * suspension happens inside `evaluateAuthorization()` or here; a request that needs
 * approval is simply refused *this* call, exactly like back-pressure, and the caller
 * (a worker re-leasing the step later) sees the outcome on its next attempt.
 */
export interface ApprovalPolicy {
  requiresApproval(request: AuthorizeEffectRequest): boolean;
}

/** The default for every existing caller — opting into an approval gate is additive, never a behavior change nobody asked for. */
export const NO_APPROVAL_REQUIRED: ApprovalPolicy = { requiresApproval: () => false };

export interface ApprovalGate {
  readonly policy: ApprovalPolicy;
  readonly approvals: PendingApprovalStore;
}

export type DispatchGuardResult =
  /** `authorizationReceipt` is `null` only when `hardening.authorizationEnforced` was false — no decision was made to attach a receipt to. */
  | { readonly admitted: true; readonly attempt: ExecutionAttempt; readonly reservationId: string; readonly authorizationReceipt: AuthorizationReceipt | null }
  /** An authorization denial *is* a durable security event — the attempt row is its only permanent trace, so it is deliberately still written. Also reached when an operator denies a pending approval — see `admitDispatch()`'s doc comment. */
  | { readonly admitted: false; readonly stage: 'AUTHORIZATION'; readonly attempt: ExecutionAttempt; readonly reason: AuthorizationRejectionReason; readonly detail: string }
  /** `attempt: null` is the invariant stated in the type: back-pressure writes no execution record. See `admitDispatch()`'s doc comment. */
  | { readonly admitted: false; readonly stage: 'CONCURRENCY'; readonly attempt: null; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] }
  /** Also writes no execution record, for the same reason as CONCURRENCY: nothing has been decided yet. `approvalId` is durable — an operator resolves it out-of-band, via `PendingApprovalStore`, and the next `admitDispatch()` call for this RunStep sees the outcome. */
  | { readonly admitted: false; readonly stage: 'ASK'; readonly attempt: null; readonly approvalId: string; readonly detail: string };

/**
 * Audit finding #7: `evaluateAuthorization()` (§8, 4.5.3) and `ConcurrencyScheduler`
 * (§9, 4.5.3) have existed since 4.5.3 as real, independently-tested mechanisms
 * that nothing ever composed — rtap/README.md's Phase 4.5.3/4.5.4 sections say so
 * explicitly, three times, across three phases. The only place they were ever run
 * together was a single integration test calling both by hand, in the right order,
 * with a hand-picked placeholder `executionAttemptId` for the reservation because
 * no real attempt existed yet at that point in the test. This is the real
 * composition — §5.1's own state diagram order, `ADMITTED -> AUTHORIZED ->
 * EFFECT_STARTED` / `ADMITTED -> REJECTED`, made real: an `ExecutionAttempt` is
 * always created first (this *is* "ADMITTED" — a dispatch was attempted, which is
 * itself worth a durable record even when it goes no further), then authorization,
 * then the concurrency reservation, each gate short-circuiting the next and
 * immediately terminalizing the attempt with the exact reason — `AUTHORIZATION_DENIED`
 * and `TARGET_UNAVAILABLE` are both real `TerminalReason` values `execution/types.ts`
 * has declared since 4.5.1/4.5.2 and nothing had ever set until this function.
 * Reserving with the *real* `executionAttemptId` (not a placeholder) also fixes what
 * the standalone test could only work around: a reservation now always correctly
 * identifies the attempt that holds it.
 *
 * Deliberately stops at admission — it does not call the adapter, and it does not
 * commit anything. What happens between "admitted" and a call to
 * `commitFencedObservation()` (the actual effect dispatch) is still not wired to
 * any real adapter; see this repo's repeated, honest "no orchestrator exists yet"
 * notes for every adapter/pipeline fix so far. `settleAttempt()` (`settle.ts`),
 * reached through `commitFencedObservation()`'s optional `scheduler` parameter, is
 * the other half: disposing of the reservation this function acquired, once the
 * effect resolves.
 *
 * **Back-pressure writes no execution record** (ARCH_CLAUDE_TRANSFER.md §2.2, from
 * Arch_claude 03 §40.1's "a work item is not ACKed until responsibility for it is
 * actually taken"). The first version created the `ExecutionAttempt` up front and, on
 * a scheduler refusal, terminalized that brand-new row as `TARGET_UNAVAILABLE`. For a
 * `TARGET_SERIAL` target, contention is the campaign's *steady state*, not a fault:
 * every contested request left a durable row asserting a failed execution attempt
 * against a target, carrying the same reason code as a genuinely unreachable one. For
 * a system whose entire value is not fabricating security truth, that is a
 * false-negative artifact in the canonical execution journal — and the `attempts`
 * count it inflated is the very thing `enumerateEligibleCandidates()` gates on.
 *
 * So the id is minted first and the row is written only once responsibility is
 * genuinely taken. Both `ExecutionAttemptStore.start()` and
 * `ConcurrencyScheduler.reserve()` already accept an injected id, so no speculative
 * `probe()` and no TOCTOU window between checking and reserving is introduced — the
 * reservation is made with the real id it will be attributed to. `TARGET_UNAVAILABLE`
 * is left to mean what it says: a target that was actually unreachable after the work
 * was claimed, not one that was merely busy.
 *
 * The authorization branch is deliberately **not** symmetric. A denial there is a
 * security event, and the terminal attempt row is its only durable trace outside
 * `AuditLog` — three of `evaluateAuthorization()`'s four rejection reasons never
 * reach `AuditingAuthorizationProvider` at all, since they are refused before the
 * provider is consulted. Dropping that row to make the two branches look alike would
 * be a security regression traded for symmetry.
 */
export type ConcurrencyProbeResult =
  | { readonly wouldAdmit: true }
  | { readonly wouldAdmit: false; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] };

/**
 * грань №19 — a read-only look-ahead at exactly the question `admitDispatch()`'s own
 * CONCURRENCY branch would answer, without leasing or reserving anything. Lets a
 * worker call this *before* `RunStepStore.lease()`, so a step that would only get
 * CONCURRENCY-refused anyway never pays the real lease's `lease_generation` bump —
 * the "Known cost, not yet paid down" `run-step-executor.ts`'s `executeLeasedStep()`
 * doc comment names, mitigated here at the worker's call site rather than by
 * restructuring `admitDispatch()`/`executeLeasedStep()` themselves.
 *
 * Deliberately has no AUTHORIZATION or ASK equivalent — two separate reasons, not
 * one:
 *   - `AuthorizationProvider` is a port, not a pure function. A real implementation
 *     already in this tree, `AuditingAuthorizationProvider`, writes an audit-log row
 *     on every `authorize()` call. A generic pre-admission authorization precheck
 *     would silently double every audit entry the moment that decorator is wired in.
 *   - The ASK durable `PendingApproval` row is written from *inside* `admitDispatch()`
 *     (`approvalGate.approvals.requestApproval()`, idempotent by `runStepId`). A
 *     pre-lease ASK precheck would have to either duplicate that idempotency outside
 *     `admitDispatch()`, or write the durable row before a lease even exists — both
 *     worse than today's status quo.
 *
 * So AUTHORIZATION_DENIED and ASK_PENDING refusals still bump `lease_generation`
 * exactly as before this fix — an accepted, explicit residual gap, pinned by
 * `redteam.execution/authorization-and-ask-still-bump-lease-generation`, not a
 * silent one.
 */
export function probeConcurrency(scheduler: ConcurrencyScheduler, request: DispatchGuardRequest): ConcurrencyProbeResult {
  const probe = scheduler.probe({ campaignId: request.authorization.campaignId, declarations: request.concurrency });
  return probe.wouldReserve ? { wouldAdmit: true } : { wouldAdmit: false, reason: probe.reason, conflicting: probe.conflicting };
}

export function admitDispatch(
  authProvider: AuthorizationProvider,
  scheduler: ConcurrencyScheduler,
  attempts: ExecutionAttemptStore,
  request: DispatchGuardRequest,
  now = new Date(),
  hardening: HardeningConfig = HARDENING_ENFORCED,
  approvalGate?: ApprovalGate,
): DispatchGuardResult {
  const effectiveClass = strictestClass(request.concurrency.map((d) => d.concurrencyClass));
  const startInput = { ...request.attemptStart, concurrencyClass: effectiveClass };
  const executionAttemptId = randomUUID();

  let authorizationReceipt: AuthorizationReceipt | null = null;
  if (hardening.authorizationEnforced) {
    const authResult = evaluateAuthorization(request.authorization, authProvider, now);
    if (!authResult.authorized) {
      attempts.start(startInput, now, executionAttemptId);
      const terminated = attempts.markTerminal(executionAttemptId, 'AUTHORIZATION_DENIED', now);
      return { admitted: false, stage: 'AUTHORIZATION', attempt: terminated, reason: authResult.reason, detail: authResult.detail };
    }
    authorizationReceipt = authResult.receipt;
  }

  // грань №12: only reached once authorization itself has already cleared (or was
  // bypassed) — approval is an additional gate on top of a request that was already
  // going to be admitted, not a replacement for authorization, and not consulted for
  // one that was already going to be denied anyway.
  if (approvalGate && approvalGate.policy.requiresApproval(request.authorization)) {
    const runStepId = request.authorization.runStepId;
    const pending =
      approvalGate.approvals.get(runStepId) ??
      approvalGate.approvals.requestApproval(
        {
          runStepId,
          campaignId: request.authorization.campaignId,
          assessmentRunId: request.authorization.assessmentRunId,
          operationFamily: request.authorization.operationFamily,
        },
        now,
      );

    if (pending.decision === null) {
      return { admitted: false, stage: 'ASK', attempt: null, approvalId: pending.approvalId, detail: 'awaiting human approval' };
    }
    if (pending.decision === 'DENIED') {
      attempts.start(startInput, now, executionAttemptId);
      const terminated = attempts.markTerminal(executionAttemptId, 'AUTHORIZATION_DENIED', now);
      return {
        admitted: false,
        stage: 'AUTHORIZATION',
        attempt: terminated,
        reason: 'POLICY_DENIED',
        detail: `denied by ${pending.decidedBy ?? 'an operator'} via approval ${pending.approvalId}`,
      };
    }
    // APPROVED — fall through to the normal reservation + attempt creation below,
    // using the authorizationReceipt evaluateAuthorization() already issued.
  }

  const reserveResult = scheduler.reserve(
    { campaignId: request.authorization.campaignId, executionAttemptId, declarations: request.concurrency },
    now,
  );
  if (!reserveResult.reserved) {
    return { admitted: false, stage: 'CONCURRENCY', attempt: null, reason: reserveResult.reason, conflicting: reserveResult.conflicting };
  }

  // The barrier is held before the row exists, so a failure here (`start()` throws
  // when the RunStep is missing) would strand it — the one place in this function
  // where a reservation could outlive the request that made it.
  let attempt: ExecutionAttempt;
  try {
    attempt = attempts.start(startInput, now, executionAttemptId);
  } catch (err) {
    scheduler.release(reserveResult.reservation.reservationId, now);
    throw err;
  }

  return { admitted: true, attempt, reservationId: reserveResult.reservation.reservationId, authorizationReceipt };
}
