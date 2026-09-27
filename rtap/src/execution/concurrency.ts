import type { ConcurrencyClass } from './types.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §9 — scheduler safety classes. `ConcurrencyClass`
 * itself already lives in `execution/types.ts` (declared alongside `ExecutionAttempt`
 * in 4.5.1, since §4.2's struct carries it) — reused here rather than redeclared.
 *
 * A promise, not a proof — and today, whose promise deserves care: unlike
 * `EngineAdapterCapabilities` (`adapters/capability.ts`), which is a property
 * registered by each adapter and checked before dispatch, nothing here is derived
 * from the target adapter at all. A `ConcurrencyDeclaration` is whatever value the
 * caller of `admitDispatch()`/`ConcurrencyScheduler.reserve()` happens to pass in —
 * there is no adapter-side registry this is validated against. `strictestClass()`
 * and a green `redteam.execution/unknown-concurrency-is-exclusive` prove the
 * scheduler enforces whatever class it is told correctly; neither proves the class
 * it was told matches what the adapter can actually tolerate running concurrently.
 * A caller that wrongly declares `READ_ONLY_PARALLEL` for an adapter that mutates
 * shared state can still corrupt it — the scheduler was never told to protect it.
 */
export interface ConcurrencyDeclaration {
  readonly concurrencyClass: ConcurrencyClass;
  readonly resourceKeys: readonly string[];
  /** Only meaningful when the effective class is READ_ONLY_PARALLEL. `null` = unbounded (subject only to provider limits, out of scope here). */
  readonly maxInFlight: number | null;
  readonly supportsCancellation: boolean;
  readonly destructive: boolean;
  readonly rateLimitScope: string | null;
}

const STRICTNESS_ORDER: readonly Exclude<ConcurrencyClass, 'UNKNOWN'>[] = ['READ_ONLY_PARALLEL', 'TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE'];

/** §9: "Undeclared concurrency normalizes to EXCLUSIVE." */
export function normalizeConcurrencyClass(concurrencyClass: ConcurrencyClass): Exclude<ConcurrencyClass, 'UNKNOWN'> {
  return concurrencyClass === 'UNKNOWN' ? 'EXCLUSIVE' : concurrencyClass;
}

/** §9: "For several declarations, the strictest class applies." One operation may carry more than one declaration (e.g. a target-scoped one and a campaign-scoped one); this is the combination rule. */
export function strictestClass(classes: readonly ConcurrencyClass[]): Exclude<ConcurrencyClass, 'UNKNOWN'> {
  if (classes.length === 0) throw new Error('strictestClass() called with no declarations');
  return classes.map(normalizeConcurrencyClass).reduce((a, b) => (STRICTNESS_ORDER.indexOf(b) > STRICTNESS_ORDER.indexOf(a) ? b : a));
}

export interface ReservationLike {
  readonly campaignId: string;
  readonly concurrencyClass: ConcurrencyClass;
  readonly resourceKeys: readonly string[];
}

/**
 * Symmetric: whether `a` and `b` may hold concurrently. Deliberately not phrased
 * as "does A block B" vs. "does B block A" — those must agree, and a symmetric
 * function is the only way to guarantee they always do. An EXCLUSIVE reservation
 * — the effective class, after `normalizeConcurrencyClass()` — conflicts with
 * everything, including another EXCLUSIVE (matching §9: "global barrier"). A
 * TARGET_SERIAL reservation conflicts with anything sharing a resource key,
 * *regardless of the other reservation's own class* — the point of TARGET_SERIAL is
 * that nothing else touches that target while it holds, not just other
 * TARGET_SERIAL reservations. CAMPAIGN_SERIAL is the same rule scoped to
 * `campaignId` instead of resource keys. Two READ_ONLY_PARALLEL (or otherwise
 * non-overlapping serial) reservations never conflict here — `maxInFlight`
 * bounding for READ_ONLY_PARALLEL is a separate, count-based check the scheduler
 * applies alongside this one, not a pairwise conflict.
 */
export function reservationsConflict(a: ReservationLike, b: ReservationLike): boolean {
  const classA = normalizeConcurrencyClass(a.concurrencyClass);
  const classB = normalizeConcurrencyClass(b.concurrencyClass);
  if (classA === 'EXCLUSIVE' || classB === 'EXCLUSIVE') return true;

  const sharesResource = a.resourceKeys.some((k) => b.resourceKeys.includes(k));
  if ((classA === 'TARGET_SERIAL' || classB === 'TARGET_SERIAL') && sharesResource) return true;

  const sameCampaign = a.campaignId === b.campaignId;
  if ((classA === 'CAMPAIGN_SERIAL' || classB === 'CAMPAIGN_SERIAL') && sameCampaign) return true;

  return false;
}
