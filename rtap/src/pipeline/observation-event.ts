import type { CampaignEventInput } from '../events/store.js';

const EVENT_TYPE_FOR_VERDICT: Record<string, string> = {
  VULNERABLE: 'VulnerabilityObserved',
  RESISTANT: 'ResistanceObserved',
  UNVERIFIED: 'ObservationUnverified',
  ERROR: 'ExecutionFailed',
};

export interface ObservationForEvent {
  readonly id: string;
  readonly verdict: string;
  readonly targetId: string;
  readonly probeId: string;
}

/**
 * Every committed Observation gets one CampaignEvent, per ARCHITECTURE.md §4
 * Execution lifecycle step 7: "Observation и CampaignEvent commit atomically". This
 * repo does not yet have a real outbox transaction spanning two SQLite statements —
 * that is real Phase 1 hardening work, not attempted here — but the event this
 * function produces is exactly the payload that transaction would carry: structured
 * fields and an EvidenceRef only, never a raw payload
 * (redteam.artifact/raw-payload-never-enters-feature-vector extends to events too).
 */
export function eventForObservation(
  observation: ObservationForEvent,
  ctx: { readonly campaignId: string; readonly assessmentRunId: string; readonly occurredAt: string },
): CampaignEventInput {
  const eventType = EVENT_TYPE_FOR_VERDICT[observation.verdict];
  if (!eventType) {
    throw new Error(`No CampaignEvent mapping for verdict ${observation.verdict}`);
  }
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${observation.id}`,
    campaignId: ctx.campaignId,
    assessmentRunId: ctx.assessmentRunId,
    occurredAt: ctx.occurredAt,
    eventType,
    sourceObservationIds: [observation.id],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId: observation.targetId, probeId: observation.probeId, verdict: observation.verdict },
  };
}

/**
 * The **denominator** a coverage claim needs, and the first producer `ProbeScheduled`
 * has ever had — it has been sitting in `campaign-event.schema.json`'s closed
 * `eventType` enum since Phase 0 with nothing emitting it (ARCH_CLAUDE_TRANSFER.md
 * §2.4).
 *
 * Without it `campaign_events` contains only what *succeeded*, so a probe that was
 * planned and never ran is indistinguishable from one that ran and found nothing:
 * `correlateFindings()` only ever sees Observations that exist, and an adapter that
 * dies on probe 40 of 200 yields a report that reads exactly like a clean sweep of
 * 200. Emitting the schedule makes absence representable, which is the precondition
 * for `buildJsonReport()` being able to refuse (`report.ts`).
 *
 * `sourceObservationIds` is legitimately `[]` — the schema requires the field but
 * sets no `minItems`, and a probe that has only been scheduled has, by construction,
 * produced no Observation yet. No `verdict` in the payload either: the reducer keys
 * `Finding` derivation off `verdict === 'VULNERABLE'`, so a scheduled probe
 * contributes its `Target`/`ProbeClass`/`PROBE_TESTS_TARGET` intent to the world and
 * nothing more, with no schema and no reducer change needed to accept it.
 */
export function eventForScheduledProbe(
  scheduled: { readonly targetId: string; readonly probeId: string },
  ctx: { readonly campaignId: string; readonly assessmentRunId: string; readonly occurredAt: string; readonly eventId: string },
): CampaignEventInput {
  return {
    schemaVersion: '1.0.0',
    eventId: ctx.eventId,
    campaignId: ctx.campaignId,
    assessmentRunId: ctx.assessmentRunId,
    occurredAt: ctx.occurredAt,
    eventType: 'ProbeScheduled',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId: scheduled.targetId, probeId: scheduled.probeId },
  };
}
