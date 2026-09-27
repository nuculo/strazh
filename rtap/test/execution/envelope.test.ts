import { describe, expect, it } from 'vitest';
import { buildEnvelope, safeEmit, type EnvelopeSink } from '../../src/execution/envelope.js';
import type { ExecutionAttempt } from '../../src/execution/types.js';

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    executionAttemptId: 'attempt-1',
    assessmentRunId: 'run-1',
    runStepId: 'step-1',
    leaseGeneration: 1,
    attemptNo: 1,
    engineAdapterId: 'promptfoo',
    engineAdapterVersion: '0.1.0',
    engineRequestId: 'req-1',
    effectId: 'effect-1',
    policySnapshotRef: null,
    targetSnapshotRef: null,
    interceptorPlanGeneration: null,
    concurrencyClass: 'UNKNOWN',
    startedAt: '2026-08-30T00:00:00.000Z',
    terminalReason: null,
    terminatedAt: null,
    ...overrides,
  };
}

describe('buildEnvelope', () => {
  it('carries the ExecutionAttempt identity fields verbatim', () => {
    const envelope = buildEnvelope('campaign-1', attempt());
    expect(envelope).toMatchObject({
      campaignId: 'campaign-1',
      assessmentRunId: 'run-1',
      runStepId: 'step-1',
      leaseGeneration: 1,
      executionAttemptId: 'attempt-1',
      effectId: 'effect-1',
      engineRequestId: 'req-1',
    });
  });

  it('defaults every extra field to null and generates a traceId when not supplied', () => {
    const envelope = buildEnvelope('campaign-1', attempt());
    expect(envelope.probeAttemptId).toBeNull();
    expect(envelope.observationId).toBeNull();
    expect(envelope.eventSequence).toBeNull();
    expect(envelope.worldGeneration).toBeNull();
    expect(envelope.worldEpoch).toBeNull();
    expect(envelope.modelDigest).toBeNull();
    expect(envelope.traceId.length).toBeGreaterThan(0);
  });

  it('accepts explicit extras', () => {
    const envelope = buildEnvelope('campaign-1', attempt(), { observationId: 'obs-1', worldEpoch: 5 });
    expect(envelope.observationId).toBe('obs-1');
    expect(envelope.worldEpoch).toBe(5);
  });
});

describe('safeEmit', () => {
  it('reports success when the sink does not throw', () => {
    const sink: EnvelopeSink = { emit: () => {} };
    expect(safeEmit(sink, buildEnvelope('campaign-1', attempt()))).toEqual({ emitted: true });
  });

  it('catches a throwing sink and reports the error, never propagating it', () => {
    const sink: EnvelopeSink = {
      emit: () => {
        throw new Error('backend unreachable');
      },
    };
    const result = safeEmit(sink, buildEnvelope('campaign-1', attempt()));
    expect(result.emitted).toBe(false);
    expect(result.error).toBe('backend unreachable');
  });
});
