import type { DatabaseSync } from 'node:sqlite';
import type { ObservationStore, ObservationRecord } from '../observations/store.js';
import type { CampaignEventStore, CampaignEventInput, CampaignEventEnvelope } from '../events/store.js';

export interface CommitResult {
  readonly observation: ObservationRecord;
  readonly event: CampaignEventEnvelope;
  readonly deduped: boolean;
}

/**
 * The raw insert pair, deliberately with no transaction management of its own —
 * shared by `commitObservationWithEvent()` (which wraps it in its own transaction
 * below) and `commitFencedObservation()` (`commit-fenced-observation.ts`), which
 * needs the *same* insert pair to happen inside a larger transaction that also
 * covers the fencing check and terminalization. SQLite doesn't support nesting a
 * second `BEGIN` inside an open transaction, so this exists specifically so
 * neither caller has to choose between duplicating the insert logic and crashing
 * on a nested transaction.
 */
export function insertObservationAndEvent(
  observations: ObservationStore,
  events: CampaignEventStore,
  observation: ObservationRecord,
  eventInput: CampaignEventInput,
  now: Date,
): CommitResult {
  const storedObservation = observations.put(observation, now);
  const { event, deduped } = events.append(eventInput, now);
  return { observation: storedObservation, event, deduped };
}

/**
 * Atomically commits an Observation and its CampaignEvent together, or neither.
 * ADAPTIVE_REDTEAM_RUNTIME.md §6: "transaction Observation plus CampaignEvent plus
 * outbox" — named there as a Phase 1 requirement, not later hardening (this repo's
 * own README previously deferred it; that was wrong, fixed here). If the event fails
 * validation or insertion, the observation insert is rolled back too — there is no
 * state where an Observation exists without a corresponding committed CampaignEvent.
 *
 * Audit finding, "make fenced commit the sole canonical API": this function is no
 * longer exported from the package's public barrel (`src/index.ts`) — it is not
 * the production commit path (`commitFencedObservation` is) and was never wired to
 * any adapter's own code. It stays a real, exported *module* function because (a)
 * `commitFencedObservation` is built directly on top of `insertObservationAndEvent`
 * above, and (b) a real set of pre-4.5 tests (`test/commit-observation.test.ts`,
 * and the Phase 1/6/R vertical slices) legitimately test this exact atomic-commit
 * primitive in isolation from Phase 4.5's fencing machinery, which those phases
 * predate — removing it would delete real, still-meaningful test coverage of a
 * still-real mechanism, not just an unused API.
 */
export function commitObservationWithEvent(
  db: DatabaseSync,
  observations: ObservationStore,
  events: CampaignEventStore,
  observation: ObservationRecord,
  eventInput: CampaignEventInput,
  now = new Date(),
): CommitResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = insertObservationAndEvent(observations, events, observation, eventInput, now);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
