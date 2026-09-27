import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { reservationsConflict, strictestClass, type ConcurrencyDeclaration, type ReservationLike } from './concurrency.js';
import type { ConcurrencyClass } from './types.js';

export interface ConcurrencyReservation {
  readonly reservationId: string;
  readonly campaignId: string;
  readonly executionAttemptId: string;
  readonly concurrencyClass: ConcurrencyClass;
  readonly resourceKeys: readonly string[];
  readonly reservedAt: string;
  readonly releasedAt: string | null;
}

export interface ReserveRequest {
  readonly campaignId: string;
  readonly executionAttemptId: string;
  readonly declarations: readonly ConcurrencyDeclaration[];
}

export type ReservationRejectionReason = 'CONFLICT' | 'READ_ONLY_PARALLEL_LIMIT_EXCEEDED';

export type ReserveResult =
  | { readonly reserved: true; readonly reservation: ConcurrencyReservation }
  | { readonly reserved: false; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] };

/**
 * EXECUTION_SAFETY_RECOVERY.md §9: "Scheduler reservation is created before
 * dispatch and released only after terminal resolution or an explicit recovery
 * takeover. An expired worker lease does not automatically release the external
 * resource — effect recovery policy applies first." Durable by design (SQLite, not
 * an in-process `Set`) — a reservation surviving a crash is the whole point; a
 * reservation is released only by an explicit `release()` call, never by a lease
 * timing out on its own.
 *
 * This class enforces `ConcurrencyClass` correctly; it does not verify that the
 * `ConcurrencyDeclaration` it was given is itself true of the underlying adapter —
 * see that interface's own doc comment (`concurrency.ts`) for why.
 */
export class ConcurrencyScheduler {
  constructor(private readonly db: DatabaseSync) {}

  reserve(request: ReserveRequest, now = new Date(), reservationId = randomUUID()): ReserveResult {
    const conflict = this.evaluateConflict(request);
    if (!conflict.clear) {
      return { reserved: false, reason: conflict.reason, conflicting: conflict.conflicting };
    }

    const reservation: ConcurrencyReservation = {
      reservationId,
      campaignId: request.campaignId,
      executionAttemptId: request.executionAttemptId,
      concurrencyClass: conflict.effectiveClass,
      resourceKeys: conflict.effectiveResourceKeys,
      reservedAt: now.toISOString(),
      releasedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO concurrency_reservations (reservation_id, campaign_id, execution_attempt_id, concurrency_class, resource_keys, reserved_at, released_at)
         VALUES (@reservationId, @campaignId, @executionAttemptId, @concurrencyClass, @resourceKeys, @reservedAt, NULL)`,
      )
      .run({
        reservationId: reservation.reservationId,
        campaignId: reservation.campaignId,
        executionAttemptId: reservation.executionAttemptId,
        concurrencyClass: reservation.concurrencyClass,
        resourceKeys: JSON.stringify(reservation.resourceKeys),
        reservedAt: reservation.reservedAt,
      });
    return { reserved: true, reservation };
  }

  /**
   * грань №19 — the read-only half of `reserve()`'s check, for a caller that wants to
   * know whether a reservation *would* be granted without taking one (a worker
   * precheck before `RunStepStore.lease()`, so a foreseeable CONFLICT never burns a
   * lease_generation for nothing). Shares `evaluateConflict()` with `reserve()`, so
   * the two cannot structurally disagree about what conflicts.
   */
  probe(request: Pick<ReserveRequest, 'campaignId' | 'declarations'>): { readonly wouldReserve: true } | { readonly wouldReserve: false; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] } {
    const conflict = this.evaluateConflict(request);
    return conflict.clear ? { wouldReserve: true } : { wouldReserve: false, reason: conflict.reason, conflicting: conflict.conflicting };
  }

  /**
   * The pure conflict computation `reserve()` and `probe()` both need — everything
   * `reserve()` used to do before its single side-effecting `INSERT`. Returns the
   * effective class/resource keys on a clear result so `reserve()` doesn't recompute
   * them; `probe()` has no use for them and discards them.
   */
  private evaluateConflict(
    request: Pick<ReserveRequest, 'campaignId' | 'declarations'>,
  ):
    | { readonly clear: true; readonly effectiveClass: ConcurrencyClass; readonly effectiveResourceKeys: readonly string[] }
    | { readonly clear: false; readonly reason: ReservationRejectionReason; readonly conflicting: readonly ConcurrencyReservation[] } {
    const effectiveClass = strictestClass(request.declarations.map((d) => d.concurrencyClass));
    const effectiveResourceKeys = [...new Set(request.declarations.flatMap((d) => d.resourceKeys))];
    const candidate: ReservationLike = { campaignId: request.campaignId, concurrencyClass: effectiveClass, resourceKeys: effectiveResourceKeys };

    const active = this.activeReservations();
    const conflicting = active.filter((r) => reservationsConflict(candidate, r));
    if (conflicting.length > 0) {
      return { clear: false, reason: 'CONFLICT', conflicting };
    }

    if (effectiveClass === 'READ_ONLY_PARALLEL') {
      const maxInFlightValues = request.declarations.filter((d) => d.concurrencyClass === 'READ_ONLY_PARALLEL').map((d) => d.maxInFlight);
      const bound = maxInFlightValues.some((m) => m === null) ? null : Math.min(...(maxInFlightValues as number[]));
      if (bound !== null) {
        const sharing = active.filter((r) => r.resourceKeys.some((k) => effectiveResourceKeys.includes(k)));
        if (sharing.length >= bound) {
          return { clear: false, reason: 'READ_ONLY_PARALLEL_LIMIT_EXCEEDED', conflicting: sharing };
        }
      }
    }

    return { clear: true, effectiveClass, effectiveResourceKeys };
  }

  release(reservationId: string, now = new Date()): void {
    this.db
      .prepare(`UPDATE concurrency_reservations SET released_at = @releasedAt WHERE reservation_id = @reservationId AND released_at IS NULL`)
      .run({ reservationId, releasedAt: now.toISOString() });
  }

  activeReservations(): ConcurrencyReservation[] {
    const rows = this.db.prepare(`SELECT * FROM concurrency_reservations WHERE released_at IS NULL`).all() as unknown as ReservationRow[];
    return rows.map(rowToReservation);
  }

  /**
   * The reservation an attempt currently holds, if any. Exists so `settleAttempt()`
   * (`execution/settle.ts`) can find what to release from the attempt id alone,
   * rather than a caller having to carry a `reservationId` around from admission all
   * the way to terminal resolution and hand the right one back. The
   * `execution_attempt_id` column has been on this table since 4.5.3; nothing read
   * it by attempt until now.
   *
   * Returns at most one: `reserve()` is only ever called once per attempt (by
   * `admitDispatch()`), so a second active reservation for the same attempt would
   * be a caller bug rather than a state this method should paper over by picking
   * one arbitrarily — `settleAttempt()` releases what this returns, and a silent
   * "some other one is still held" would be exactly the leak this is fixing.
   */
  activeReservationForAttempt(executionAttemptId: string): ConcurrencyReservation | null {
    const rows = this.db
      .prepare(`SELECT * FROM concurrency_reservations WHERE execution_attempt_id = @executionAttemptId AND released_at IS NULL`)
      .all({ executionAttemptId }) as unknown as ReservationRow[];
    if (rows.length > 1) {
      throw new Error(`ExecutionAttempt ${executionAttemptId} holds ${rows.length} active reservations — admitDispatch() reserves exactly once per attempt`);
    }
    return rows[0] ? rowToReservation(rows[0]) : null;
  }
}

interface ReservationRow {
  reservation_id: string;
  campaign_id: string;
  execution_attempt_id: string;
  concurrency_class: string;
  resource_keys: string;
  reserved_at: string;
  released_at: string | null;
}

function rowToReservation(row: ReservationRow): ConcurrencyReservation {
  return {
    reservationId: row.reservation_id,
    campaignId: row.campaign_id,
    executionAttemptId: row.execution_attempt_id,
    concurrencyClass: row.concurrency_class as ConcurrencyClass,
    resourceKeys: JSON.parse(row.resource_keys) as string[],
    reservedAt: row.reserved_at,
    releasedAt: row.released_at,
  };
}
