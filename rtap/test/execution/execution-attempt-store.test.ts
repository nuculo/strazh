import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../../src/execution/execution-attempt-store.js';

const LEASE_MS = 1000;

function setup() {
  const db = openInMemoryDatabase();
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  return { db, runSteps, attempts };
}

describe('ExecutionAttemptStore.start', () => {
  it('binds a fresh attempt to the RunStep\'s current lease generation and attempt number', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    const leased = runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS })!;

    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    expect(attempt.leaseGeneration).toBe(leased.leaseGeneration);
    expect(attempt.attemptNo).toBe(leased.attempt);
    expect(attempt.terminalReason).toBeNull();
    expect(attempt.concurrencyClass).toBe('UNKNOWN'); // default — no scheduler declares one yet
    expect(attempt.interceptorPlanGeneration).toBeNull(); // default — no InterceptorPlan supplied
  });

  it('carries interceptorPlanGeneration through when a compiled plan is supplied', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({
      assessmentRunId: 'run-1',
      runStepId: step.id,
      engineAdapterId: 'promptfoo',
      engineAdapterVersion: '0.1.0',
      engineRequestId: 'req-1',
      interceptorPlanGeneration: 3,
    });
    expect(attempt.interceptorPlanGeneration).toBe(3);
    expect(attempts.get(attempt.executionAttemptId)?.interceptorPlanGeneration).toBe(3);
  });

  it('never reuses an execution_attempt_id across retries', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const a1 = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    const a2 = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-2' });
    expect(a1.executionAttemptId).not.toBe(a2.executionAttemptId);
  });

  it('throws for a RunStep that does not exist', () => {
    const { attempts } = setup();
    expect(() =>
      attempts.start({ assessmentRunId: 'run-1', runStepId: 'no-such-step', engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' }),
    ).toThrow();
  });
});

describe('ExecutionAttemptStore.markTerminal', () => {
  it('sets terminalReason and terminatedAt', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });

    const terminal = attempts.markTerminal(attempt.executionAttemptId, 'COMPLETED');
    expect(terminal.terminalReason).toBe('COMPLETED');
    expect(terminal.terminatedAt).not.toBeNull();
  });

  it('is immutable once terminal — a second call throws rather than overwriting', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });

    attempts.markTerminal(attempt.executionAttemptId, 'COMPLETED');
    expect(() => attempts.markTerminal(attempt.executionAttemptId, 'CANCELLED')).toThrow();
  });
});

describe('ExecutionAttemptStore.bindNativeResult — fencing', () => {
  it('permits a result bound to the active, non-terminal attempt', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });

    const result = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' });
    expect(result).toEqual({ permitted: true });
  });

  it('rejects RUN_STEP_NOT_FOUND for an unknown step', () => {
    const { attempts } = setup();
    const result = attempts.bindNativeResult({ runStepId: 'no-such-step', executionAttemptId: 'no-such-attempt', nativeResultRef: 'ref-1' });
    expect(result).toEqual({ permitted: false, reason: 'RUN_STEP_NOT_FOUND' });
  });

  it('rejects ATTEMPT_NOT_FOUND for an unknown attempt id on a real step', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    const result = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: 'no-such-attempt', nativeResultRef: 'ref-1' });
    expect(result).toEqual({ permitted: false, reason: 'ATTEMPT_NOT_FOUND' });
  });

  it('rejects ATTEMPT_BELONGS_TO_DIFFERENT_STEP when the attempt is real but for another step', () => {
    const { runSteps, attempts } = setup();
    const { step: stepA } = runSteps.enqueue('run-1', 'kA', {});
    const { step: stepB } = runSteps.enqueue('run-1', 'kB', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attemptA = attempts.start({ assessmentRunId: 'run-1', runStepId: stepA.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });

    const result = attempts.bindNativeResult({ runStepId: stepB.id, executionAttemptId: attemptA.executionAttemptId, nativeResultRef: 'ref-1' });
    expect(result).toEqual({ permitted: false, reason: 'ATTEMPT_BELONGS_TO_DIFFERENT_STEP' });
  });

  it('rejects ATTEMPT_ALREADY_TERMINAL', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    attempts.markTerminal(attempt.executionAttemptId, 'COMPLETED');

    const result = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' });
    expect(result).toEqual({ permitted: false, reason: 'ATTEMPT_ALREADY_TERMINAL' });
  });

  it('rejects STALE_LEASE_RESULT for the exact lease-takeover sequence in EXECUTION_SAFETY_RECOVERY.md §7.1', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    const now = new Date('2026-08-30T00:00:00.000Z');

    runSteps.lease('run-1', { owner: 'worker-a', leaseDurationMs: LEASE_MS, now: () => now });
    const attemptA7 = attempts.start(
      { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-a' },
      now,
    );

    const later = new Date(now.getTime() + LEASE_MS + 1);
    runSteps.lease('run-1', { owner: 'worker-b', leaseDurationMs: LEASE_MS, now: () => later });
    const attemptB8 = attempts.start(
      { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-b' },
      later,
    );
    expect(attemptB8.leaseGeneration).toBeGreaterThan(attemptA7.leaseGeneration);

    // Worker A's late native result for its now-superseded attempt.
    const lateResult = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attemptA7.executionAttemptId, nativeResultRef: 'ref-a7-late' });
    expect(lateResult).toEqual({ permitted: false, reason: 'STALE_LEASE_RESULT' });

    // Worker B's on-time result for the current generation.
    const currentResult = attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attemptB8.executionAttemptId, nativeResultRef: 'ref-b8' });
    expect(currentResult).toEqual({ permitted: true });
  });

  it('records every rejection in quarantineHistory, including the reason', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: 'ghost', nativeResultRef: 'ref-1' });

    const history = attempts.quarantineHistory(step.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ runStepId: step.id, executionAttemptId: 'ghost', nativeResultRef: 'ref-1', reason: 'ATTEMPT_NOT_FOUND' });
  });

  it('does not quarantine a permitted bind', () => {
    const { runSteps, attempts } = setup();
    const { step } = runSteps.enqueue('run-1', 'k1', {});
    runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
    const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
    attempts.bindNativeResult({ runStepId: step.id, executionAttemptId: attempt.executionAttemptId, nativeResultRef: 'ref-1' });
    expect(attempts.quarantineHistory(step.id)).toEqual([]);
  });

  describe('campaignId/targetId identity (ARCH_CLAUDE_TRANSFER.md §2.5)', () => {
    it('copies campaignId/targetId from the RunStep at start() time, the same way leaseGeneration/attemptNo already are', () => {
      const { runSteps, attempts } = setup();
      const { step } = runSteps.enqueue('run-1', 'k1', {}, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
      const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
      expect(attempt.campaignId).toBe('campaign-1');
      expect(attempt.targetId).toBe('target-1');
    });

    it('is null on both fields when the RunStep carries no identity', () => {
      const { runSteps, attempts } = setup();
      const { step } = runSteps.enqueue('run-1', 'k1', {});
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
      const attempt = attempts.start({ assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-1' });
      expect(attempt.campaignId).toBeNull();
      expect(attempt.targetId).toBeNull();
    });

    it('listByCampaign() returns every attempt recorded against a campaign, terminal or not', () => {
      const { runSteps, attempts } = setup();
      const { step: stepA } = runSteps.enqueue('run-1', 'kA', {}, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
      const { step: stepB } = runSteps.enqueue('run-1', 'kB', {}, new Date(), { campaignId: 'campaign-2', targetId: 'target-2' });
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: LEASE_MS });
      const attemptA = attempts.start({ assessmentRunId: 'run-1', runStepId: stepA.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-a' });
      attempts.start({ assessmentRunId: 'run-1', runStepId: stepB.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: 'req-b' });

      const campaign1Attempts = attempts.listByCampaign('campaign-1');
      expect(campaign1Attempts).toHaveLength(1);
      expect(campaign1Attempts[0]!.executionAttemptId).toBe(attemptA.executionAttemptId);
    });
  });
});
