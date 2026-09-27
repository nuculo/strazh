import { mulberry32, randInt } from '../rng.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { RunStepStore } from '../../runsteps/store.js';
import { ExecutionAttemptStore } from '../../execution/execution-attempt-store.js';
import { ObservationStore } from '../../observations/store.js';
import { CampaignEventStore } from '../../events/store.js';
import { commitFencedObservations, type ObservationEventPair } from '../../pipeline/commit-fenced-observation.js';
import { eventForObservation } from '../../pipeline/observation-event.js';
import type { Law } from '../types.js';

// грань №17: commitFencedObservation() generalized to N Observation/CampaignEvent
// pairs sharing one execution attempt (duo-static/duo-llm workers). No prior
// document names IDs for these — derived directly from that facet's own design.

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const { step } = runSteps.enqueue('run-1', 'key-1', { probeId: 'probe-1' });
  runSteps.lease('run-1', { owner: 'worker-0', leaseDurationMs: 60_000 });
  const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'duo-static', engineAdapterVersion: '0.1.0', engineRequestId: 'req-0' });
  return { db, runSteps, attempts, observations, events, step, attempt };
}

function pairFor(id: string): ObservationEventPair {
  const observation = {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1',
    assessmentRunId: 'run-1',
    verdict: 'UNVERIFIED',
    evidenceRefs: [],
    provenance: {
      engineId: 'duo-static',
      engineVersion: '0.1.0',
      adapterVersion: '0.1.0',
      schemaVersion: '1.0.0',
      nativeRunId: 'native-run-1',
      nativeResultId: id,
      graderKind: 'none',
    },
  } as never;
  return { observation, event: eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: '2026-08-31T00:00:00.000Z' }) };
}

export const pipelineLaws: Law[] = [
  {
    id: 'redteam.pipeline/commit-fenced-observations-shares-one-attempt',
    statement:
      'commitFencedObservations() commits every one of N (1-8) Observation/CampaignEvent pairs under the same executionAttemptId from one bind+terminalize, not once per pair (which would reject from the second pair on with ATTEMPT_ALREADY_TERMINAL) — commits.length always equals the input length, and every stored Observation carries the one attempt id.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const { db, attempts, observations, events, step, attempt } = setup();
      const n = randInt(rng, 1, 8);
      const pairs = Array.from({ length: n }, (_, i) => pairFor(`obs-${seed}-${i}`));

      const result = commitFencedObservations(
        db,
        observations,
        events,
        attempts,
        { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' },
        pairs,
      );

      if (!result.committed) {
        return { held: false, detail: 'commit was refused on a fresh, unfenced attempt', counterexample: { seed, n, bindResult: result.bindResult } };
      }
      if (result.commits.length !== n) {
        return { held: false, detail: `expected ${n} commits, got ${result.commits.length} — a per-pair bind would stop after the first`, counterexample: { seed, n, got: result.commits.length } };
      }
      const stored = observations.listByAssessmentRun('run-1');
      if (stored.length !== n || !stored.every((o) => o.executionAttemptId === attempt.executionAttemptId)) {
        return { held: false, detail: 'not every stored Observation carries the one shared executionAttemptId', counterexample: { seed, n, stored: stored.map((o) => o.executionAttemptId) } };
      }
      const settled = attempts.get(attempt.executionAttemptId);
      if (settled?.terminalReason !== 'COMPLETED') {
        return { held: false, detail: 'attempt was not marked COMPLETED after a successful multi-pair commit', counterexample: { seed, n, terminalReason: settled?.terminalReason ?? null } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.pipeline/commit-fenced-observations-empty-pairs-still-completes',
    statement:
      'commitFencedObservations() called with zero pairs still binds and terminalizes the attempt as COMPLETED and returns {committed: true, commits: []} — a clean scan with nothing to report is a real, successful attempt, not a failure to commit.',
    status: 'implemented',
    trials: 30,
    check: ({ seed }) => {
      const { db, attempts, observations, events, step, attempt } = setup();
      const result = commitFencedObservations(db, observations, events, attempts, { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: `ref-${seed}` }, []);

      if (!result.committed) {
        return { held: false, detail: 'an empty-pairs commit was refused', counterexample: { seed, bindResult: result.bindResult } };
      }
      if (result.commits.length !== 0) {
        return { held: false, detail: 'an empty-pairs commit produced non-empty commits', counterexample: { seed, commits: result.commits } };
      }
      const settled = attempts.get(attempt.executionAttemptId);
      if (settled?.terminalReason !== 'COMPLETED') {
        return { held: false, detail: 'attempt was not marked COMPLETED after an empty-pairs commit', counterexample: { seed, terminalReason: settled?.terminalReason ?? null } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.pipeline/commit-fenced-observations-fencing-rejects-all-or-nothing',
    statement:
      'When the fencing check refuses (the attempt is already terminal, superseded by a newer lease before commitFencedObservations() runs), none of the N pairs are committed — not a partial subset — and the caller sees committed:false with the real BindResult rejection reason.',
    status: 'implemented',
    trials: 60,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const { db, runSteps, attempts, observations, events, step, attempt } = setup();
      // Supersede the lease before committing — the exact §7.1 race, same setup
      // execution-safety.laws.ts's own fencing laws use.
      runSteps.lease('run-1', { owner: 'worker-1', leaseDurationMs: 60_000, now: () => new Date(Date.now() + 120_000) });

      const n = randInt(rng, 1, 5);
      const pairs = Array.from({ length: n }, (_, i) => pairFor(`obs-${seed}-${i}`));
      const result = commitFencedObservations(db, observations, events, attempts, { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: `ref-${seed}` }, pairs);

      if (result.committed) {
        return { held: false, detail: 'a fenced-out attempt still committed observations', counterexample: { seed, n } };
      }
      if (observations.listByAssessmentRun('run-1').length !== 0) {
        return { held: false, detail: 'a refused commit still left some observations stored — not all-or-nothing', counterexample: { seed, n, stored: observations.listByAssessmentRun('run-1').length } };
      }
      if (result.bindResult.reason !== 'STALE_LEASE_RESULT') {
        return { held: false, detail: `expected STALE_LEASE_RESULT, got ${result.bindResult.reason}`, counterexample: { seed, n, reason: result.bindResult.reason } };
      }
      return { held: true };
    },
  },
];
