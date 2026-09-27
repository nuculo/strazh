import type { DatabaseSync } from 'node:sqlite';
import type { AuthorizationProvider } from '../authz/types.js';
import type { CampaignEventStore } from '../events/store.js';
import type { ObservationStore } from '../observations/store.js';
import type { RunStepStore, LeaseOptions } from '../runsteps/store.js';
import type { RunStep } from '../runsteps/types.js';
import { commitFencedObservations, type ObservationEventPair } from '../pipeline/commit-fenced-observation.js';
import { admitDispatch, probeConcurrency, type ApprovalGate, type DispatchGuardRequest } from './dispatch.js';
import { settleAttempt } from './settle.js';
import type { ConcurrencyScheduler, ConcurrencyReservation } from './concurrency-scheduler.js';
import type { ExecutionAttemptStore } from './execution-attempt-store.js';
import type { AuthorizationRejectionReason } from './authorization.js';
import type { ReservationRejectionReason } from './concurrency-scheduler.js';
import type { ExecutionAttempt, TerminalReason } from './types.js';

/**
 * The failure reasons a `StepRunner` is allowed to declare. Deliberately a subset of
 * `TerminalReason` — a runner cannot report success through the failure channel, and
 * cannot claim `COMPLETED`/`OBSERVATION_COMMITTED`, which are the executor's to write
 * only after a commit actually happened.
 */
export type StepFailureReason = Extract<
  TerminalReason,
  'FAILED_BEFORE_EFFECT' | 'TIMED_OUT_BEFORE_EFFECT' | 'CAPABILITY_UNSUPPORTED' | 'TARGET_UNAVAILABLE' | 'NORMALIZATION_FAILED' | 'UNKNOWN_EFFECT_OUTCOME'
>;

export type StepOutcome =
  | {
      readonly ok: true;
      /** Ref to the persisted native artifact — in practice a `materializeEvidence()` ref. Bound and fenced, never re-derived here. */
      readonly nativeResultRef: string;
      /**
       * грань №17: one native invocation can yield zero, one, or many
       * Observation/CampaignEvent pairs (promptfoo: always exactly one; duo-static/
       * duo-llm: one per finding/attack, possibly zero on a clean scan) — all of
       * them are fenced and committed under this one attempt via
       * `commitFencedObservations()`, never one `commitFencedObservation()` call
       * per pair (which would fail from the second pair on — see that function's
       * doc comment).
       */
      readonly observations: readonly ObservationEventPair[];
    }
  | { readonly ok: false; readonly terminalReason: StepFailureReason; readonly detail: string };

/**
 * One engine's composition: dispatch the adapter, materialize its evidence, and
 * normalize the result into an Observation plus its CampaignEvent. Injected rather
 * than imported, which is what keeps this module free of any `adapters/*` import —
 * see `executeLeasedStep()`'s doc comment.
 *
 * A runner that *knows* its effect never started must say so
 * (`FAILED_BEFORE_EFFECT`); a runner that throws is telling the executor nothing,
 * and is treated accordingly.
 */
export type StepRunner = (attempt: ExecutionAttempt) => Promise<StepOutcome>;

export type StepResult =
  /**
   * Back-pressure: the barrier was held, so nothing was admitted and no effect
   * lifecycle ever began. Not a terminal `EffectLifecycleState`, because there was
   * no effect — ARCH_CLAUDE_TRANSFER.md §2.2. The RunStep is deliberately left as it
   * is, to be re-leased once its lease lapses.
   */
  | { readonly outcome: 'ADMISSION_REFUSED'; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] }
  /**
   * грань №12: an operation this step's request matched an `ApprovalPolicy` on
   * writes no execution record either, for the same reason as `ADMISSION_REFUSED` —
   * nothing has been decided yet. The RunStep is left exactly as it is, same as
   * back-pressure; a later re-lease sees whatever an operator resolved
   * `approvalId` to in the meantime, via `PendingApprovalStore`.
   */
  | { readonly outcome: 'ASK_PENDING'; readonly approvalId: string; readonly detail: string }
  /** Authorization denied — `REJECTED` in §5.1's lifecycle. The attempt row is the denial's durable trace. */
  | { readonly outcome: 'REJECTED'; readonly attempt: ExecutionAttempt; readonly reason: AuthorizationRejectionReason; readonly detail: string }
  /** The runner failed or could not be classified. `terminalReason` is what the attempt was settled with. */
  | { readonly outcome: 'FAILED'; readonly attempt: ExecutionAttempt; readonly terminalReason: StepFailureReason; readonly detail: string }
  /** A fencing rejection: this attempt's lease was superseded while it ran. The native result is quarantined, never committed. */
  | { readonly outcome: 'FENCED'; readonly attempt: ExecutionAttempt }
  /**
   * The whole path completed: every Observation + CampaignEvent + outbox row
   * committed for this attempt, attempt settled, barrier released. `observations`
   * is empty when the runner legitimately found nothing to commit (грань №17) —
   * the attempt is still genuinely COMMITTED, just with zero rows.
   */
  | { readonly outcome: 'COMMITTED'; readonly attempt: ExecutionAttempt; readonly observations: readonly { readonly observationId: string; readonly deduped: boolean }[] };

/**
 * **The single execution semantics for every delivery surface** (ARCH_CLAUDE_TRANSFER.md
 * §2.3, from Arch_claude 02 §19.1: `query.ts` is the one source of model/tool-loop
 * semantics for both the interactive REPL and headless/SDK — the shells differ, the
 * loop never does).
 *
 * Until now RTAP said "sole path" three times and all three were about *commit*
 * (`commit-fenced-observation.ts`, `commit-observation.ts`, `index.ts`), never about
 * *execution*. Admission, dispatch, fencing, settlement and step bookkeeping were
 * composed only inside integration tests — two of them, differently. This is that
 * composition as real code, so the CLI, an MCP server, a GitLab hook and an API
 * (ARCHITECTURE.md §9's Phase 7 delivery surfaces, none of them written yet) cannot
 * each grow their own subtly different order of operations. Fixing the invariant now
 * is cheap; retrofitting it across four surfaces later is not.
 *
 * Deliberately **stateless and connection-free between calls**: it takes one already
 * leased RunStep and returns one terminal outcome. The process-level lease loop stays
 * a thin caller (a future `bin/`), keyed by `assessmentRunId` the way
 * `RunStepStore.lease()` is — not by campaign, which is the materializer's key, not
 * this one's.
 *
 * **No `adapters/*` import.** Engine-specific composition (`adapter.run()` →
 * `materializeEvidence()` → `parse*()`) lives outside, in a `StepRunner` closure. That
 * keeps each adapter's `ExecFn` injection untouched, keeps this module testable
 * without any engine, and keeps `redteam.adapter/unsupported-capability-is-rejected`
 * legal — that law instantiates `DuoLlmCliAdapter` directly, so the rule this file
 * establishes is "the executor is the only *production* caller of `adapters/&#42;/run.ts`",
 * not "the only caller anywhere".
 *
 * Ports are passed individually rather than as one context object. That is the
 * `ToolUseContext` trap Arch_claude 01:466-480 names as an antipattern in its own
 * source system, and `admitDispatch()` already set the precedent here.
 *
 * ## Order of operations
 *
 * ```text
 *   admitDispatch()        AUTHORIZATION denied → step FAILED, attempt REJECTED
 *        │                 CONCURRENCY refused  → nothing written, step left to re-lease
 *        ▼
 *   markRunning()
 *        ▼
 *   runner(attempt)        throws → UNKNOWN_EFFECT_OUTCOME (barrier retained)
 *        │                 {ok:false} → the reason the runner declared
 *        ▼
 *   commitFencedObservations(…, scheduler)  fencing reject → FENCED, quarantined
 *        │                                  success → settle COMPLETED + release
 *        ▼
 *   runSteps.complete()
 * ```
 *
 * **A thrown runner is not a failed effect.** `{ok:false, terminalReason}` is the
 * runner classifying its own failure — it is the only party that knows whether the
 * adapter was ever dispatched. An *unhandled throw* tells the executor nothing, and
 * §7.2/§13's rule is that absence of evidence is never evidence of absence, so it
 * settles as `UNKNOWN_EFFECT_OUTCOME`: barrier retained, RUNBOOK.md Part A. That is
 * deliberately expensive — a runner that knows its effect never started should say
 * `FAILED_BEFORE_EFFECT` and get the barrier released for free.
 *
 * **Known cost, not yet paid down**: admission runs *after* the lease, because
 * `ExecutionAttemptStore.start()` copies `RunStep.leaseGeneration` at creation and an
 * attempt minted before the lease would be stale the moment `lease()` incremented it.
 * So a concurrency refusal has already consumed a lease generation — fencing out a
 * previous attempt's in-flight late result for work this call then declines to do.
 * Bounded (that previous lease had already expired, so it was going to be fenced by
 * whoever leased next) but real. Paying it down fully means admitting before leasing,
 * which means splitting attempt creation out of `admitDispatch()` — a larger change
 * than this one. грань №19 mitigates the common case cheaply instead, at the worker's
 * call site rather than in here: `leaseWithConcurrencyPrecheck()` below lets a caller
 * check `probeConcurrency()` *before* `RunStepStore.lease()`, so a step that would
 * only get CONCURRENCY-refused never gets leased at all. `executeLeasedStep()` itself
 * is unchanged — a step admitted via the precheck still runs the real, unmodified
 * `admitDispatch()` here as the authority, and AUTHORIZATION/ASK refusals still
 * consume a lease generation exactly as before, since neither has a cheap precheck
 * (see `probeConcurrency()`'s doc comment in `dispatch.ts` for why).
 */
export async function executeLeasedStep(
  db: DatabaseSync,
  runSteps: RunStepStore,
  attempts: ExecutionAttemptStore,
  observations: ObservationStore,
  events: CampaignEventStore,
  scheduler: ConcurrencyScheduler,
  authProvider: AuthorizationProvider,
  request: DispatchGuardRequest,
  runner: StepRunner,
  leaseOwner: string,
  now = new Date(),
  approvalGate?: ApprovalGate,
): Promise<StepResult> {
  const runStepId = request.attemptStart.runStepId;

  const admission = admitDispatch(authProvider, scheduler, attempts, request, now, undefined, approvalGate);
  if (!admission.admitted) {
    if (admission.stage === 'CONCURRENCY') {
      // Nothing was written and nothing is held. The step keeps its lease until it
      // lapses, then becomes re-leasable on its own — a refusal on capacity must not
      // burn the step, which `fail()` would.
      return { outcome: 'ADMISSION_REFUSED', reason: admission.reason, conflicting: admission.conflicting };
    }
    if (admission.stage === 'ASK') {
      // Same treatment as CONCURRENCY, for the same reason: nothing was decided, so
      // nothing about the step's own lease state should change.
      return { outcome: 'ASK_PENDING', approvalId: admission.approvalId, detail: admission.detail };
    }
    runSteps.fail(runStepId, leaseOwner, `authorization denied: ${admission.reason} — ${admission.detail}`, now);
    return { outcome: 'REJECTED', attempt: admission.attempt, reason: admission.reason, detail: admission.detail };
  }

  const attempt = admission.attempt;
  runSteps.markRunning(runStepId, leaseOwner);

  let produced: StepOutcome;
  try {
    produced = await runner(attempt);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const settled = settleAttempt(attempts, scheduler, attempt.executionAttemptId, 'UNKNOWN_EFFECT_OUTCOME', now);
    runSteps.fail(runStepId, leaseOwner, `runner threw, effect outcome unproven: ${detail}`, now);
    return { outcome: 'FAILED', attempt: settled.attempt, terminalReason: 'UNKNOWN_EFFECT_OUTCOME', detail };
  }

  if (!produced.ok) {
    const settled = settleAttempt(attempts, scheduler, attempt.executionAttemptId, produced.terminalReason, now);
    runSteps.fail(runStepId, leaseOwner, `${produced.terminalReason}: ${produced.detail}`, now);
    return { outcome: 'FAILED', attempt: settled.attempt, terminalReason: produced.terminalReason, detail: produced.detail };
  }

  const commit = commitFencedObservations(
    db,
    observations,
    events,
    attempts,
    { runStepId, executionAttemptId: attempt.executionAttemptId, nativeResultRef: produced.nativeResultRef },
    produced.observations,
    now,
    scheduler,
  );

  if (!commit.committed) {
    // The fencing check refused: this attempt's lease was superseded while it ran, so
    // the result is quarantined (bindNativeResult()'s own side effect) and must not
    // become an Observation. The step is not failed — whoever holds the lease now
    // owns its outcome, and this call has no standing to decide it.
    const refetched = attempts.get(attempt.executionAttemptId) ?? attempt;
    return { outcome: 'FENCED', attempt: refetched };
  }

  runSteps.complete(runStepId, leaseOwner, now);
  const settledAttempt = attempts.get(attempt.executionAttemptId) ?? attempt;
  return {
    outcome: 'COMMITTED',
    attempt: settledAttempt,
    observations: commit.commits.map((c) => ({ observationId: c.observation.id, deduped: c.deduped })),
  };
}

export type ConcurrencyPrecheckResult<TPayload> =
  | { readonly outcome: 'LEASED'; readonly step: RunStep<TPayload> }
  /** No lease was taken — grань №19's fix. The candidate stays exactly as it was, re-leasable once whatever it conflicts with clears. */
  | { readonly outcome: 'BLOCKED'; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] }
  /** The targeted lease() lost the row to a racing lease between peek and this call — not a bug, the same cross-process boundary RunStepStore's own doc comment already draws. */
  | { readonly outcome: 'RACED' };

/**
 * грань №19 — peek→probe→targeted-lease, composed. A caller (a worker's drain loop)
 * must already have peeked `candidateId` via `RunStepStore.peekLeasable()` and built
 * `request` from it: the malformed-step check (`campaignId`/`targetId` both
 * required) has to run on the peeked candidate first, before a `DispatchGuardRequest`
 * can even be built, and that check is engine-specific (its error message differs
 * per worker), so it stays the caller's job rather than being swallowed in here.
 *
 * Zero `await` between the concurrency probe and the real, `stepId`-targeted
 * `lease()` call below — node:sqlite is synchronous, so nothing in this process can
 * interleave and change either answer in between. Single-process guarantee only,
 * the same boundary `RunStepStore`'s own doc comment already draws; this says
 * nothing new about multiple processes/machines sharing one SQLite file.
 *
 * Does not call `executeLeasedStep()` — that stays the caller's job too, unchanged.
 */
export function leaseWithConcurrencyPrecheck<TPayload>(
  runSteps: RunStepStore,
  scheduler: ConcurrencyScheduler,
  assessmentRunId: string,
  candidateId: string,
  request: DispatchGuardRequest,
  leaseOptions: LeaseOptions,
): ConcurrencyPrecheckResult<TPayload> {
  const probe = probeConcurrency(scheduler, request);
  if (!probe.wouldAdmit) {
    return { outcome: 'BLOCKED', reason: probe.reason, conflicting: probe.conflicting };
  }
  const step = runSteps.lease<TPayload>(assessmentRunId, { ...leaseOptions, stepId: candidateId });
  return step ? { outcome: 'LEASED', step } : { outcome: 'RACED' };
}
