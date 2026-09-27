import type { DatabaseSync } from 'node:sqlite';

/**
 * грань №20 — the durable home ARCH_CLAUDE_TRANSFER.md §2.4 step 4 specifies for
 * `assessment_run_id`, and the consumer for two facts that were computed and
 * discarded: FROZEN_INTEGRATION.md:136's `intelligence_status=DEGRADED`
 * (`rankCandidates().usedFallback`, `shadow/rank.ts`) and the
 * `coverage_acceptance`/`accepted_by`/`accepted_at` columns the architecture doc
 * names but does not specify the behavior of.
 *
 * Lives next to `run-once.ts` — its one real caller — rather than in a new
 * top-level directory, the same reasoning `execution/approval-store.ts` living
 * beside its own hot caller (`admitDispatch()`) already establishes.
 *
 * `start()` is the only way a row comes into existence — no lazy/implicit creation
 * anywhere else in this file, in `run-once.ts`, or in `dispatch.ts` (deliberately
 * untouched by this fix). `recordIntelligenceStatus()` and `acceptCoverage()` are
 * both tolerant no-ops against a missing row rather than throws: `runPlannerOnce()`
 * and its many existing tests have no reason to know about `start()` at all, the
 * same optionality `dispatch.ts`'s own `ScheduleEventContext` already has for a
 * caller with no campaign context.
 */
export type IntelligenceStatus = 'HEALTHY' | 'DEGRADED';

export interface AssessmentRunRecord {
  readonly assessmentRunId: string;
  readonly campaignId: string;
  readonly intelligenceStatus: IntelligenceStatus;
  readonly intelligenceStatusUpdatedAt: string;
  /** Set once, on the first transition into DEGRADED — never cleared, even once intelligenceStatus recovers to HEALTHY. See this file's own doc comment. */
  readonly everDegradedAt: string | null;
  readonly startedAt: string;
  readonly coverageAcceptance: string | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
}

/**
 * Thrown by `start()` when a second call names a different campaignId for an
 * assessmentRunId that already has a row — an identifier collision between two
 * logically different runs, not a benign retry (matching `SigningKeyStore.register()`'s
 * "collision is an operator mistake, surface it" precedent, not
 * `PendingApprovalStore.requestApproval()`'s tolerant same-key idempotency).
 */
export class AssessmentRunCampaignMismatchError extends Error {
  constructor(assessmentRunId: string, existingCampaignId: string, attemptedCampaignId: string) {
    super(
      `AssessmentRun "${assessmentRunId}" already started under campaign "${existingCampaignId}" — cannot restart it under a different campaign "${attemptedCampaignId}". assessment_run_id identifies one run of one campaign; reuse a fresh id instead.`,
    );
    this.name = 'AssessmentRunCampaignMismatchError';
  }
}

export interface RecordIntelligenceStatusResult {
  /** false iff no row exists for this assessmentRunId — i.e. start() was never called. Never throws in that case. */
  readonly recorded: boolean;
  readonly record: AssessmentRunRecord | null;
}

export type AcceptCoverageResult =
  | { readonly accepted: true; readonly record: AssessmentRunRecord }
  | { readonly accepted: false; readonly reason: 'NOT_FOUND' }
  /** Someone already accepted — the exact race the conditional UPDATE below exists to prevent either side from winning silently, same shape as PendingApprovalStore.resolve()'s ALREADY_DECIDED. */
  | { readonly accepted: false; readonly reason: 'ALREADY_ACCEPTED'; readonly record: AssessmentRunRecord };

interface AssessmentRunRow {
  assessment_run_id: string;
  campaign_id: string;
  intelligence_status: string;
  intelligence_status_updated_at: string;
  ever_degraded_at: string | null;
  started_at: string;
  coverage_acceptance: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
}

function fromRow(row: AssessmentRunRow): AssessmentRunRecord {
  return {
    assessmentRunId: row.assessment_run_id,
    campaignId: row.campaign_id,
    intelligenceStatus: row.intelligence_status as IntelligenceStatus,
    intelligenceStatusUpdatedAt: row.intelligence_status_updated_at,
    everDegradedAt: row.ever_degraded_at,
    startedAt: row.started_at,
    coverageAcceptance: row.coverage_acceptance,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
  };
}

export class AssessmentRunStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * The one required precondition call: a delivery surface must call this before
   * `runPlannerOnce()` ever runs for `assessmentRunId`. Idempotent when
   * `campaignId` matches (a retried delivery-surface invocation for the same
   * assessment run gets back the same row, never a second insert, `startedAt` not
   * refreshed). Throws `AssessmentRunCampaignMismatchError` on a genuine mismatch.
   */
  start(assessmentRunId: string, campaignId: string, now = new Date()): AssessmentRunRecord {
    const existing = this.get(assessmentRunId);
    if (existing) {
      if (existing.campaignId !== campaignId) {
        throw new AssessmentRunCampaignMismatchError(assessmentRunId, existing.campaignId, campaignId);
      }
      return existing;
    }
    const nowIso = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO assessment_runs (assessment_run_id, campaign_id, intelligence_status, intelligence_status_updated_at, ever_degraded_at, started_at, coverage_acceptance, accepted_by, accepted_at)
         VALUES (@assessmentRunId, @campaignId, 'HEALTHY', @nowIso, NULL, @nowIso, NULL, NULL, NULL)`,
      )
      .run({ assessmentRunId, campaignId, nowIso });
    const created = this.get(assessmentRunId);
    if (!created) throw new Error(`AssessmentRun ${assessmentRunId} vanished immediately after insert`);
    return created;
  }

  get(assessmentRunId: string): AssessmentRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM assessment_runs WHERE assessment_run_id = @assessmentRunId`).get({ assessmentRunId }) as AssessmentRunRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Non-monotonic: overwrites `intelligence_status`/`intelligence_status_updated_at`
   * unconditionally with this call's result — DEGRADED never latches the field
   * itself, HEALTHY never has to "clear" a past DEGRADED. Matches
   * FROZEN_INTEGRATION.md's framing of worker unavailability as transient and what
   * a present-tense field name implies. `ever_degraded_at` is the separate,
   * permanent audit trail: the `CASE`/`COALESCE` below stamps it once, on the
   * first-ever DEGRADED write, and leaves it untouched on every write after —
   * including a later HEALTHY one. A safe no-op (`{recorded: false, record: null}`)
   * when no row exists — never throws, never creates a row.
   */
  recordIntelligenceStatus(assessmentRunId: string, status: IntelligenceStatus, now = new Date()): RecordIntelligenceStatusResult {
    const nowIso = now.toISOString();
    const result = this.db
      .prepare(
        `UPDATE assessment_runs
         SET intelligence_status = @status,
             intelligence_status_updated_at = @nowIso,
             ever_degraded_at = CASE WHEN @status = 'DEGRADED' THEN COALESCE(ever_degraded_at, @nowIso) ELSE ever_degraded_at END
         WHERE assessment_run_id = @assessmentRunId`,
      )
      .run({ assessmentRunId, status, nowIso });
    if (Number(result.changes) === 0) return { recorded: false, record: null };
    return { recorded: true, record: this.get(assessmentRunId) };
  }

  /**
   * Idempotent, first-decision-wins — the same `WHERE accepted_at IS NULL`
   * conditional-UPDATE idiom `PendingApprovalStore.resolve()`/`SigningKeyStore.revoke()`
   * already use. `note` is the operator's free-text justification, stored verbatim
   * in `coverage_acceptance` — the same `revoked_reason` shape `signing_keys`
   * already established. Not gated on `intelligenceStatus` — a general sign-off,
   * most commonly exercised after a DEGRADED run but not restricted to one.
   */
  acceptCoverage(assessmentRunId: string, note: string, acceptedBy: string, now = new Date()): AcceptCoverageResult {
    const acceptedAt = now.toISOString();
    const result = this.db
      .prepare(`UPDATE assessment_runs SET coverage_acceptance = @note, accepted_by = @acceptedBy, accepted_at = @acceptedAt WHERE assessment_run_id = @assessmentRunId AND accepted_at IS NULL`)
      .run({ assessmentRunId, note, acceptedBy, acceptedAt });
    if (Number(result.changes) === 0) {
      const existing = this.get(assessmentRunId);
      if (!existing) return { accepted: false, reason: 'NOT_FOUND' };
      return { accepted: false, reason: 'ALREADY_ACCEPTED', record: existing };
    }
    const updated = this.get(assessmentRunId);
    if (!updated) throw new Error(`AssessmentRun ${assessmentRunId} vanished immediately after acceptCoverage()`);
    return { accepted: true, record: updated };
  }

  listAll(): AssessmentRunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM assessment_runs ORDER BY started_at ASC`).all() as unknown as AssessmentRunRow[];
    return rows.map(fromRow);
  }
}
