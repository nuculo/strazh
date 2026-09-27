import type { DatabaseSync } from 'node:sqlite';
import { RunStepStore } from '../runsteps/store.js';
import { eventForScheduledProbe } from '../pipeline/observation-event.js';
import type { CampaignEventStore } from '../events/store.js';
import type { PlannerDecision } from './mixer.js';

/**
 * The campaign context a `ProbeScheduled` event needs (ARCH_CLAUDE_TRANSFER.md §2.4).
 * Optional on `dispatchDecisions()` only because a `PlannerDecision` does not reliably
 * carry a campaignId — `binding` has one but exists solely for the model arm — so the
 * pre-Phase-4 planner tests that predate CampaignWorld genuinely have no campaign to
 * name. Any caller that *has* one is expected to pass it: without it the run has no
 * coverage denominator, and `buildAssessmentReport()` will refuse to call the result
 * an assessment at all, which is the intended pressure.
 */
export interface ScheduleEventContext {
  readonly events: CampaignEventStore;
  readonly campaignId: string;
}

export interface DispatchedStep {
  readonly targetId: string;
  readonly probeId: string;
  readonly arm: PlannerDecision['arm'];
  readonly runStepId: string;
  readonly deduped: boolean;
}

/**
 * The one function in this repo that turns a Planner decision into a durable
 * RunStep — deliberately isolated here so "who is allowed to create a RunStep" has
 * exactly one answer. Phase 3's shadow scorer cannot reach this (no RunStepStore
 * dependency at all); Phase 5's mixer only *decides*, it never calls this itself —
 * dispatch is a separate, explicit step, so a caller can inspect a MixResult before
 * committing to it.
 *
 * Idempotency key is `${targetId}:${probeId}:${arm}:${policyVersion}` —
 * `targetId` was a real bug, found by audit: without it, dispatching the same
 * probe for two different Targets produced the *same* idempotency key, so the
 * second Target's dispatch silently deduped against the first Target's RunStep
 * and never actually got its own unit of work. The RunStep payload also now
 * carries `targetId` (a worker cannot know what to attack without it — this was
 * never optional, just missing) and the decision's own `binding`, when present,
 * for audit/replay.
 */
export function dispatchDecisions(
  db: DatabaseSync,
  assessmentRunId: string,
  decisions: readonly PlannerDecision[],
  policyVersion: string,
  now = new Date(),
  schedule?: ScheduleEventContext,
): DispatchedStep[] {
  const runSteps = new RunStepStore(db);
  const dispatchedAt = now.toISOString();
  const insert = db.prepare(
    `INSERT INTO planner_dispatch_log (assessment_run_id, run_step_id, target_id, probe_id, arm, policy_version, deduped, dispatched_at)
     VALUES (@assessmentRunId, @runStepId, @targetId, @probeId, @arm, @policyVersion, @deduped, @dispatchedAt)`,
  );

  const results: DispatchedStep[] = [];
  for (const decision of decisions) {
    const idempotencyKey = `${decision.targetId}:${decision.probeId}:${decision.arm}:${policyVersion}`;
    const { step, deduped } = runSteps.enqueue(
      assessmentRunId,
      idempotencyKey,
      { targetId: decision.targetId, probeId: decision.probeId, arm: decision.arm, binding: decision.binding },
      now,
      // ARCH_CLAUDE_TRANSFER.md §2.5 — same optionality as the ProbeScheduled event
      // just below: no `schedule` means no campaignId to attribute this RunStep to,
      // same pre-Phase-4-test callers this file's own doc comment already names.
      schedule ? { campaignId: schedule.campaignId, targetId: decision.targetId } : undefined,
    );
    insert.run({
      assessmentRunId,
      runStepId: step.id,
      targetId: decision.targetId,
      probeId: decision.probeId,
      arm: decision.arm,
      policyVersion,
      deduped: deduped ? 1 : 0,
      dispatchedAt,
    });
    // The coverage denominator, emitted at the one place a unit of work comes into
    // existence. `eventId` is derived from the same idempotency key the RunStep is,
    // so a deduped dispatch reuses it and `CampaignEventStore.append()`'s own
    // duplicate-eventId idempotency collapses it — a re-dispatch cannot inflate the
    // denominator any more than it can create a second RunStep. Neither this nor
    // `enqueue()` opens a transaction, so both land in whatever the caller has open.
    if (schedule) {
      schedule.events.append(
        eventForScheduledProbe(
          { targetId: decision.targetId, probeId: decision.probeId },
          { campaignId: schedule.campaignId, assessmentRunId, occurredAt: dispatchedAt, eventId: `evt-scheduled:${idempotencyKey}` },
        ),
      );
    }

    results.push({ targetId: decision.targetId, probeId: decision.probeId, arm: decision.arm, runStepId: step.id, deduped });
  }
  return results;
}

export interface DispatchLogEntry {
  readonly assessmentRunId: string;
  readonly runStepId: string;
  readonly targetId: string;
  readonly probeId: string;
  readonly arm: PlannerDecision['arm'];
  readonly policyVersion: string;
  readonly dispatchedAt: string;
}

export function listDispatchLog(db: DatabaseSync, assessmentRunId: string): DispatchLogEntry[] {
  const rows = db
    .prepare(`SELECT * FROM planner_dispatch_log WHERE assessment_run_id = @assessmentRunId ORDER BY dispatched_at ASC`)
    .all({ assessmentRunId }) as {
    assessment_run_id: string;
    run_step_id: string;
    target_id: string;
    probe_id: string;
    arm: string;
    policy_version: string;
    dispatched_at: string;
  }[];
  return rows.map((r) => ({
    assessmentRunId: r.assessment_run_id,
    runStepId: r.run_step_id,
    targetId: r.target_id,
    probeId: r.probe_id,
    arm: r.arm as PlannerDecision['arm'],
    policyVersion: r.policy_version,
    dispatchedAt: r.dispatched_at,
  }));
}
