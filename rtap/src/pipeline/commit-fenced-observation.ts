import type { DatabaseSync } from 'node:sqlite';
import type { ObservationStore, ObservationRecord } from '../observations/store.js';
import type { CampaignEventStore, CampaignEventInput } from '../events/store.js';
import type { ExecutionAttemptStore } from '../execution/execution-attempt-store.js';
import type { ConcurrencyScheduler } from '../execution/concurrency-scheduler.js';
import type { BindResult, NativeResultBinding } from '../execution/types.js';
import { settleAttempt } from '../execution/settle.js';
import { insertObservationAndEvent, type CommitResult } from './commit-observation.js';

export type FencedCommitResult = { readonly committed: true; readonly commit: CommitResult } | { readonly committed: false; readonly bindResult: BindResult };

export interface ObservationEventPair {
  readonly observation: ObservationRecord;
  readonly event: CampaignEventInput;
}

export type FencedCommitResults = { readonly committed: true; readonly commits: readonly CommitResult[] } | { readonly committed: false; readonly bindResult: BindResult };

/**
 * Thin, signature-preserving wrapper over `commitFencedObservations()` (below) for
 * the common one-Observation case — every pre-existing caller of this function
 * (the promptfoo worker, the execution-safety laws, `test/pipeline/commit-fenced-
 * observation.test.ts`) keeps compiling and behaving identically. See
 * `commitFencedObservations()`'s doc comment for the actual mechanics.
 */
export function commitFencedObservation(
  db: DatabaseSync,
  observations: ObservationStore,
  events: CampaignEventStore,
  attempts: ExecutionAttemptStore,
  binding: NativeResultBinding,
  observation: ObservationRecord,
  eventInput: CampaignEventInput,
  now = new Date(),
  scheduler?: ConcurrencyScheduler,
): FencedCommitResult {
  const result = commitFencedObservations(db, observations, events, attempts, binding, [{ observation, event: eventInput }], now, scheduler);
  if (!result.committed) return result;
  return { committed: true, commit: result.commits[0]! };
}

/**
 * EXECUTION_SAFETY_RECOVERY.md §15 admission criterion 2: "each Observation
 * contains a binding to an active ExecutionAttempt." **This is the sole canonical
 * commit path** — audit finding "make fenced commit the sole canonical API":
 * `commitObservationWithEvent()` (`commit-observation.ts`) is no longer exported
 * from the package's public barrel; nothing outside tests for pre-4.5 phases
 * should call it directly. `src/worker/promptfoo-worker.ts` has called this path
 * (via `commitFencedObservation()`, the singular wrapper above) since грань
 * (закрытие пробела 1)/`260cc95`; `duo-static-worker.ts`/`duo-llm-worker.ts`
 * (грань №17) are the second and third real callers, via this plural form.
 *
 * Everything — fencing check, quarantine-on-reject, the Observation/CampaignEvent
 * insert pair, and terminalizing the attempt on success — happens inside **one**
 * transaction, not several. The previous version called
 * `ExecutionAttemptStore.bindNativeResult()` (its own implicit-transaction reads
 * and, on rejection, its quarantine insert) and then a *separately* transactional
 * `commitObservationWithEvent()`, with `markTerminal()` after that had committed —
 * three separate points of atomicity, not one. Between the first and the rest, a
 * concurrent lease takeover (a real possibility for the eventual multi-process
 * PostgreSQL profile, though not for this repo's single-connection SQLite one —
 * see `db/connection.ts`) could have staled the fencing decision before the
 * commit used it; and a crash between the commit and `markTerminal()` would have
 * left a genuinely committed Observation attached to an attempt that never got
 * marked `COMPLETED`. Merging the whole sequence into one `BEGIN IMMEDIATE` /
 * `COMMIT` removes both windows, not just documents them. `bindNativeResult()`
 * and `markTerminal()` were already written with no transaction management of
 * their own (SQLite executes a statement inside whatever transaction is
 * currently open, or autocommits if none is), so calling them here — inside a
 * transaction *this* function opened — was always safe; the only structural
 * change needed was replacing the call to `commitObservationWithEvent()` (which
 * opens its own `BEGIN`, and SQLite does not support nesting one transaction
 * inside another) with the shared, non-transactional `insertObservationAndEvent()`
 * it and `commitObservationWithEvent()` both build on.
 *
 * On success the attempt is marked terminal with reason `COMPLETED` (added in
 * 4.5.2, once `TerminalReason` existed) — without this, a successfully committed
 * attempt stayed indistinguishable from a merely-active one, which the 4.5.2
 * reconciler needs to tell apart (`EffectReconciler.reconcile()` refuses to run on
 * an already-terminal attempt).
 *
 * Also carries the attempt's `interceptorPlanGeneration` (4.5.4, §10: "plan
 * generation enters ExecutionAttempt and provenance Observation") into
 * `provenance.interceptorPlanGeneration` — `null` for every attempt today, since
 * nothing yet dispatches under a compiled `InterceptorPlan`, but the field is
 * populated from the real attempt record rather than hardcoded, so it starts
 * carrying real values the moment something does.
 *
 * "Validate active lease owner" (the audit's own phrasing): there is no separate
 * owner field checked here beyond `leaseGeneration` — an `executionAttemptId` is
 * an unguessable UUID minted fresh by `ExecutionAttemptStore.start()`, so
 * possessing a valid one is itself the only proof of ownership this repo's
 * single-process model needs; `leaseGeneration` is what enforces *exclusivity*
 * (only the current lease holder's attempts have a generation that still
 * matches). Adding a separate, redundant owner-string check would duplicate that
 * guarantee, not strengthen it.
 *
 * Audit finding #7's other half, since reworked: passing the optional `scheduler`
 * makes the success path settle through `settleAttempt()` (`execution/settle.ts`),
 * which marks the attempt `COMPLETED` *and* disposes of whatever barrier
 * `admitDispatch()` acquired for it, inside this same transaction —
 * `ConcurrencyScheduler.release()` opens no `BEGIN` of its own, so it joins this one
 * exactly like `insertObservationAndEvent()` and the outbox insert already do,
 * making "released only after terminal resolution" (§9) atomic with the resolution
 * itself rather than a separate step a caller could forget or crash between.
 *
 * This used to take a `DispatchGuard { scheduler, reservationId }`, i.e. it asked
 * the caller to carry a reservation id from admission all the way here and hand back
 * the right one. That is gone: `settleAttempt()` looks the reservation up from the
 * attempt id in durable state, so a caller can no longer pass a stale or simply
 * wrong id, and the release now follows from the attempt's identity rather than from
 * the caller's bookkeeping.
 *
 * Still deliberately *not* released on the reject branch: a fencing rejection
 * doesn't tell this function whether the attempt that held the reservation is
 * actually done — one of its own rejection reasons is literally
 * `ATTEMPT_ALREADY_TERMINAL`, i.e. someone else may already have resolved it a
 * different way, and that resolution owned the barrier's fate. Terminal states this
 * function does not itself produce (CANCELLED, TIMED_OUT_BEFORE_EFFECT, an adapter
 * throwing before any commit) are settled by their own caller through
 * `settleAttempt()`, which is now the one place that pairing lives.
 *
 * грань №17: generalizes `commitFencedObservation()` to *N* Observation/CampaignEvent
 * pairs bound to the *same* execution attempt — the shape a single duo-static scan
 * or duo-llm redteam run actually produces (one native invocation, many findings),
 * unlike promptfoo's one-invocation-one-result assumption. The fencing check
 * (`bindNativeResult()`) and the terminal-mark (`settleAttempt()`/`markTerminal()`)
 * both happen exactly ONCE per call, not once per pair — binding and terminalizing
 * are properties of the *attempt*, not of any individual Observation, so calling
 * `commitFencedObservation()` in a loop for the same `executionAttemptId` would
 * fail from the second iteration on (`bindNativeResult()`'s own
 * `ATTEMPT_ALREADY_TERMINAL` rejection, since the first iteration already marks the
 * attempt COMPLETED). This function is the one, correct way to commit more than one
 * Observation for a single dispatched attempt.
 *
 * `pairs` may legitimately be empty — a scan that finds nothing is still a real,
 * successful execution (the fencing/terminal bookkeeping for *that attempt* is
 * exactly as meaningful as if it had found something), not a normalization
 * failure. An empty `pairs` still binds and terminalizes the attempt, and returns
 * `{committed: true, commits: []}`.
 *
 * `commitFencedObservation()` (singular) is now a thin wrapper around this function
 * with a one-element array — its own signature, and every existing caller of it,
 * are unchanged.
 */
export function commitFencedObservations(
  db: DatabaseSync,
  observations: ObservationStore,
  events: CampaignEventStore,
  attempts: ExecutionAttemptStore,
  binding: NativeResultBinding,
  pairs: readonly ObservationEventPair[],
  now = new Date(),
  scheduler?: ConcurrencyScheduler,
): FencedCommitResults {
  db.exec('BEGIN IMMEDIATE');
  try {
    const bindResult = attempts.bindNativeResult(binding, now);
    if (!bindResult.permitted) {
      db.exec('COMMIT'); // the quarantine record bindNativeResult() just wrote is real, durable audit data — commit it, don't discard it
      return { committed: false, bindResult };
    }

    const attempt = attempts.get(binding.executionAttemptId);
    const commits: CommitResult[] = [];
    for (const pair of pairs) {
      const provenance = (pair.observation as { provenance?: Record<string, unknown> }).provenance ?? {};
      const boundObservation: ObservationRecord = {
        ...pair.observation,
        executionAttemptId: binding.executionAttemptId,
        provenance: { ...provenance, interceptorPlanGeneration: attempt?.interceptorPlanGeneration ?? null },
      };
      commits.push(insertObservationAndEvent(observations, events, boundObservation, pair.event, now));
    }
    if (scheduler) {
      settleAttempt(attempts, scheduler, binding.executionAttemptId, 'COMPLETED', now);
    } else {
      attempts.markTerminal(binding.executionAttemptId, 'COMPLETED', now);
    }
    db.exec('COMMIT');
    return { committed: true, commits };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
