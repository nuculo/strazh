import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { commitFencedObservation } from '../../src/pipeline/commit-fenced-observation.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { compilePlan, evaluateStageOutcomes, type InterceptorDescriptor } from '../../src/execution/interceptor.js';
import { buildEnvelope, safeEmit, type EnvelopeSink } from '../../src/execution/envelope.js';
import { InMemoryMetricsRecorder, OPERATIONAL_METRICS } from '../../src/execution/metrics.js';
import { evaluatePhase5Admission } from '../../src/execution/admission.js';
import { buildRegistry } from '../../src/laws/index.js';
import { replay } from '../../src/world/replay.js';

function validObservation(id: string) {
  return {
    id,
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1:strategy-1',
    assessmentRunId: 'run-1',
    verdict: 'VULNERABLE',
    evidenceRefs: [],
    provenance: {
      engineId: 'promptfoo',
      engineVersion: '0.122.0',
      adapterVersion: '0.1.0',
      schemaVersion: '1.0.0',
      nativeRunId: 'native-run-1',
      nativeResultId: id,
      graderKind: 'llm-judge',
    },
  };
}

/**
 * Phase 4.5.4 vertical slice: a compiled InterceptorPlan gates PRE_DISPATCH (a
 * failed security-critical check blocks dispatch; once it passes, dispatch
 * proceeds), the attempt carries the plan's generation, telemetry is emitted
 * best-effort alongside the canonical commit (and a failing sink changes nothing
 * about the outcome), and metrics are recorded for the terminal attempt — ending
 * with an honest admission-suite read confirming Phase 5 is still not admissible.
 */
describe('Phase 4.5.4 vertical slice: interceptors and operations', () => {
  it('a failed security-critical interceptor blocks dispatch; once it passes, the plan generation and telemetry flow through to a real commit', () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const attempts = new ExecutionAttemptStore(db, runSteps);
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);
    const metrics = new InMemoryMetricsRecorder();

    const descriptors: InterceptorDescriptor[] = [
      { interceptorId: 'egress-guard', version: '1.0.0', stage: 'PRE_DISPATCH', criticality: 'SECURITY_CRITICAL', inputSchema: 's:in', outputSchema: 's:out', timeoutMs: 500, sideEffectPolicy: 'NONE' },
      { interceptorId: 'usage-logger', version: '1.0.0', stage: 'PRE_DISPATCH', criticality: 'ADVISORY', inputSchema: 's:in', outputSchema: 's:out', timeoutMs: 500, sideEffectPolicy: 'TELEMETRY_ONLY' },
    ];
    const plan = compilePlan(1, 'policy-v1', descriptors);
    expect(plan.orderedDescriptors.map((d) => d.interceptorId)).toEqual(['egress-guard', 'usage-logger']);

    // First attempt: the security-critical egress guard fails — dispatch must not proceed.
    const blockedStage = evaluateStageOutcomes(plan, 'PRE_DISPATCH', [
      { interceptorId: 'egress-guard', ok: false, diagnostic: 'destination not in allowlist' },
      { interceptorId: 'usage-logger', ok: true },
    ]);
    expect(blockedStage.admitted).toBe(false);
    expect(blockedStage.failedCritical).toEqual(['egress-guard']);

    // Second attempt: egress guard passes; the advisory logger fails open with a diagnostic.
    const admittedStage = evaluateStageOutcomes(plan, 'PRE_DISPATCH', [
      { interceptorId: 'egress-guard', ok: true },
      { interceptorId: 'usage-logger', ok: false, diagnostic: 'log sink slow, dropped' },
    ]);
    expect(admittedStage.admitted).toBe(true);
    expect(admittedStage.failedAdvisory).toEqual([{ interceptorId: 'usage-logger', diagnostic: 'log sink slow, dropped' }]);

    // Dispatch for real, carrying the plan generation onto the attempt.
    const { step } = runSteps.enqueue('run-1', 'probe-1-key', { probeId: 'probe-1:strategy-1' });
    runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: 1000 });
    const attempt = attempts.start({
      assessmentRunId: 'run-1',
      runStepId: step.id,
      engineAdapterId: 'promptfoo',
      engineAdapterVersion: '0.1.0',
      engineRequestId: 'req-1',
      interceptorPlanGeneration: plan.planGeneration,
    });
    expect(attempt.interceptorPlanGeneration).toBe(1);

    // Telemetry is emitted best-effort — a failing sink must not affect the canonical commit.
    const envelope = buildEnvelope('campaign-1', attempt);
    const failingSink: EnvelopeSink = {
      emit: () => {
        throw new Error('telemetry backend down');
      },
    };
    const emitResult = safeEmit(failingSink, envelope);
    expect(emitResult.emitted).toBe(false);
    metrics.incrementCounter(OPERATIONAL_METRICS.executionAttemptsTotal, { adapter: 'promptfoo', terminal_reason: 'pending' });

    const observation = validObservation('obs-1');
    const eventInput = eventForObservation(observation, { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: new Date(0).toISOString() });
    const commit = commitFencedObservation(db, observations, events, attempts, { runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' }, observation, eventInput);
    expect(commit.committed).toBe(true);
    if (commit.committed) {
      // The plan generation reached the committed Observation's provenance.
      expect((commit.commit.observation['provenance'] as { interceptorPlanGeneration: number | null }).interceptorPlanGeneration).toBe(1);
    }

    metrics.incrementCounter(OPERATIONAL_METRICS.executionAttemptsTotal, { adapter: 'promptfoo', terminal_reason: 'COMPLETED' });
    expect(metrics.recorded).toHaveLength(2);

    const allEvents = events.listByCampaign('campaign-1');
    const result = replay(allEvents, 'campaign-1');
    expect(result.stoppedAt).toBeNull();
  });

  it('the honest admission suite reports every law-backed criterion this repo can actually prove as MET', async () => {
    // As of this delivery (4.5.4), Phase 5 was still inadmissible — criteria 12 and
    // 14 were both open. Both closed later (worker/ for 12, the rollback drill for
    // 14; see rtap/README.md), so report.admissible is no longer asserted false here
    // — this test's job was always to confirm the law-backed criteria, not to pin
    // the overall verdict to a point-in-time state that was expected to change.
    const report = await evaluatePhase5Admission(buildRegistry());
    const lawBacked = report.criteria.filter((c) => [1, 3, 4, 5, 6, 7, 8, 9, 10].includes(c.id));
    expect(lawBacked.every((c) => c.status === 'MET')).toBe(true);
  });
});
