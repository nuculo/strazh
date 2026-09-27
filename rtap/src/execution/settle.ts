import type { ConcurrencyReservation, ConcurrencyScheduler } from './concurrency-scheduler.js';
import type { ExecutionAttemptStore } from './execution-attempt-store.js';
import type { ExecutionAttempt, TerminalReason } from './types.js';

/**
 * What happened to the attempt's scheduler reservation as part of settling it.
 * `RETAINED` is a first-class outcome, not an omission: §9's release rule has a
 * deliberate exception (see `settleAttempt()` below), and collapsing "held on
 * purpose" into "no reservation" would hide exactly the state
 * [RUNBOOK.md](../../RUNBOOK.md) Part B exists to resolve by hand.
 */
export type ReservationDisposition =
  | { readonly kind: 'RELEASED'; readonly reservationId: string }
  | { readonly kind: 'RETAINED'; readonly reservationId: string; readonly why: 'UNKNOWN_EFFECT_OUTCOME' }
  | { readonly kind: 'NONE' };

export interface SettleResult {
  readonly attempt: ExecutionAttempt;
  readonly reservation: ReservationDisposition;
}

/**
 * Whether reaching this terminal reason releases the attempt's scheduler barrier.
 *
 * Deliberately a `switch` with a `never` exhaustiveness check rather than a
 * `Set`/array of "retaining" reasons: adding a member to `TerminalReason` must not
 * compile until someone has decided which side of this line it falls on. Getting it
 * wrong in either direction is a real failure — releasing too eagerly lets new work
 * start against a target whose previous effect may still be in flight, and retaining
 * too eagerly wedges a `TARGET_SERIAL`/`CAMPAIGN_SERIAL`/`EXCLUSIVE` barrier that
 * nothing will ever come back to clear.
 */
function releasesOnSettlement(reason: TerminalReason): boolean {
  switch (reason) {
    // §6: an effect whose outcome could not be proven either way is "a durable
    // business outcome, not a transient exception." Releasing here would free the
    // target for new work while the old effect may still be genuinely in flight —
    // precisely the double-dispatch that TARGET_SERIAL/CAMPAIGN_SERIAL/EXCLUSIVE
    // exist to prevent. The barrier is held until an operator resolves the attempt
    // out of band (RUNBOOK.md Part A), then releases it explicitly (Part B).
    case 'UNKNOWN_EFFECT_OUTCOME':
      return false;

    // Everything else is settled: either the effect provably never happened, or it
    // happened and its result is now recorded, or the attempt never got far enough
    // to have an effect at all. In every one of these the resource is genuinely free.
    case 'COMPLETED':
    case 'CANCELLED':
    case 'TIMED_OUT_BEFORE_EFFECT':
    case 'AUTHORIZATION_DENIED':
    case 'CAPABILITY_UNSUPPORTED':
    case 'TARGET_UNAVAILABLE':
    case 'FAILED_BEFORE_EFFECT':
    case 'NORMALIZATION_FAILED':
    case 'STALE_LEASE_RESULT':
    case 'OBSERVATION_COMMITTED':
      return true;

    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * The single way an `ExecutionAttempt` reaches a terminal state: mark it terminal
 * and dispose of whatever scheduler barrier admission acquired for it, together.
 *
 * EXECUTION_SAFETY_RECOVERY.md §9 states the rule — a reservation "is released only
 * after terminal resolution or an explicit recovery takeover" — and RTAP has stated
 * it three separate times (§9 itself, `concurrency-scheduler.ts`'s own doc comment,
 * and RUNBOOK.md Part B). What was missing was anything that *did* it: `release()`
 * had exactly one caller, `commitFencedObservation()`'s success path, so every other
 * way an attempt could terminalize — a reconciler resolving it, a fencing rejection,
 * an adapter throwing — stranded its reservation with `released_at IS NULL` forever.
 * For a `TARGET_SERIAL`/`CAMPAIGN_SERIAL`/`EXCLUSIVE` class that silently wedges all
 * future work on that resource, with no error raised anywhere.
 *
 * Order is load-bearing: `markTerminal()` runs *first*, and it already rejects a
 * second settlement of an already-terminal attempt ("attempts are immutable once
 * terminal", `execution-attempt-store.ts`). So "exactly one settlement per attempt"
 * is inherited rather than re-implemented, and a loser in a double-settle race
 * throws before it can release a barrier the winner's settlement already decided the
 * fate of.
 *
 * Opens no transaction of its own, matching `markTerminal()`/`release()`/
 * `bindNativeResult()`: SQLite cannot nest a `BEGIN`, and the callers that matter
 * (`commitFencedObservation()`) already hold one — so the settlement lands inside
 * the caller's transaction and rolls back with it, rather than surviving a rollback
 * as a half-applied release.
 */
export function settleAttempt(
  attempts: ExecutionAttemptStore,
  scheduler: ConcurrencyScheduler,
  executionAttemptId: string,
  reason: TerminalReason,
  now = new Date(),
): SettleResult {
  const attempt = attempts.markTerminal(executionAttemptId, reason, now);

  const held: ConcurrencyReservation | null = scheduler.activeReservationForAttempt(executionAttemptId);
  if (held === null) {
    return { attempt, reservation: { kind: 'NONE' } };
  }
  if (!releasesOnSettlement(reason)) {
    return { attempt, reservation: { kind: 'RETAINED', reservationId: held.reservationId, why: 'UNKNOWN_EFFECT_OUTCOME' } };
  }
  scheduler.release(held.reservationId, now);
  return { attempt, reservation: { kind: 'RELEASED', reservationId: held.reservationId } };
}
