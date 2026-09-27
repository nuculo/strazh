import { describe, expect, it } from 'vitest';
import { CampaignEventStore } from '../../src/events/store.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { dispatchDecisions, listDispatchLog } from '../../src/planner/dispatch.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import type { PlannerDecision } from '../../src/planner/mixer.js';

const decisions: PlannerDecision[] = [
  { targetId: 't1', probeId: 'p1', arm: 'mandatory', binding: null },
  { targetId: 't1', probeId: 'p2', arm: 'model', binding: null },
  { targetId: 't1', probeId: 'p3', arm: 'heuristic', binding: null },
];

describe('dispatchDecisions', () => {
  it('enqueues one RunStep per decision', () => {
    const db = openInMemoryDatabase();
    const results = dispatchDecisions(db, 'run-1', decisions, 'policy-1');
    expect(results).toHaveLength(3);
    expect(new RunStepStore(db).listByAssessmentRun('run-1')).toHaveLength(3);
  });

  it('records each dispatch in the log with its arm', () => {
    const db = openInMemoryDatabase();
    dispatchDecisions(db, 'run-1', decisions, 'policy-1');
    const log = listDispatchLog(db, 'run-1');
    expect(log.map((l) => l.arm).sort()).toEqual(['heuristic', 'mandatory', 'model']);
  });

  it('is idempotent: dispatching the same decisions twice does not create duplicate RunSteps', () => {
    const db = openInMemoryDatabase();
    dispatchDecisions(db, 'run-1', decisions, 'policy-1');
    const second = dispatchDecisions(db, 'run-1', decisions, 'policy-1');
    expect(second.every((r) => r.deduped)).toBe(true);
    expect(new RunStepStore(db).listByAssessmentRun('run-1')).toHaveLength(3);
  });

  it('a different policyVersion produces a distinct idempotency key — re-dispatch under a new policy is not deduped', () => {
    const db = openInMemoryDatabase();
    dispatchDecisions(db, 'run-1', decisions, 'policy-1');
    const second = dispatchDecisions(db, 'run-1', decisions, 'policy-2');
    expect(second.every((r) => !r.deduped)).toBe(true);
    expect(new RunStepStore(db).listByAssessmentRun('run-1')).toHaveLength(6);
  });

  it('the same probeId for two different targets produces two distinct RunSteps, never a dedup collision — the exact bug this phase fixes', () => {
    const db = openInMemoryDatabase();
    const crossTarget: PlannerDecision[] = [
      { targetId: 't-A', probeId: 'shared-probe', arm: 'model', binding: null },
      { targetId: 't-B', probeId: 'shared-probe', arm: 'model', binding: null },
    ];
    const results = dispatchDecisions(db, 'run-1', crossTarget, 'policy-1');
    expect(results.every((r) => !r.deduped)).toBe(true);
    expect(new Set(results.map((r) => r.runStepId)).size).toBe(2);
    expect(new RunStepStore(db).listByAssessmentRun('run-1')).toHaveLength(2);

    const log = listDispatchLog(db, 'run-1');
    expect(log.map((l) => l.targetId).sort()).toEqual(['t-A', 't-B']);
  });

  it('emits the ProbeScheduled coverage denominator when a campaign context is supplied, and a deduped re-dispatch does not inflate it', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const schedule = { events, campaignId: 'campaign-1' };

    dispatchDecisions(db, 'run-1', decisions, 'policy-1', new Date(0), schedule);
    const first = events.listByCampaign('campaign-1');
    expect(first).toHaveLength(decisions.length);
    expect(first.every((e) => e.eventType === 'ProbeScheduled')).toBe(true);

    // Same decisions again: RunSteps dedup, and so must the denominator.
    dispatchDecisions(db, 'run-1', decisions, 'policy-1', new Date(0), schedule);
    expect(events.listByCampaign('campaign-1')).toHaveLength(decisions.length);
  });

  it('without a campaign context no denominator is emitted — the pre-Phase-4 path still works, and the report will call that coverage UNKNOWN', () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    dispatchDecisions(db, 'run-1', decisions, 'policy-1');
    expect(events.listByCampaign('campaign-1')).toHaveLength(0);
  });
});
