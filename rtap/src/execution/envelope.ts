import { randomUUID } from 'node:crypto';
import type { ExecutionAttempt } from './types.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §11 — `OperationalEnvelope`. "Carried through logs,
 * traces and metrics, but is not source of truth. Canonical binding is read from
 * the domain store." This type exists purely to be *emitted*, never to be read
 * back and trusted — nothing in this package ever constructs domain decisions
 * from an `OperationalEnvelope`, only from `ExecutionAttemptStore`/
 * `EffectReceiptStore`/`ObservationStore` themselves.
 */
export interface OperationalEnvelope {
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly runStepId: string;
  readonly leaseGeneration: number;
  readonly executionAttemptId: string;
  readonly effectId: string | null;
  readonly engineRequestId: string;
  readonly probeAttemptId: string | null;
  readonly observationId: string | null;
  readonly eventSequence: number | null;
  readonly worldGeneration: number | null;
  readonly worldEpoch: number | null;
  readonly modelDigest: string | null;
  readonly traceId: string;
}

export interface EnvelopeExtras {
  readonly probeAttemptId?: string | null;
  readonly observationId?: string | null;
  readonly eventSequence?: number | null;
  readonly worldGeneration?: number | null;
  readonly worldEpoch?: number | null;
  readonly modelDigest?: string | null;
}

/** Builds an envelope from an `ExecutionAttempt`'s own durable identity fields — never from process memory or a caller's belief about state. */
export function buildEnvelope(campaignId: string, attempt: ExecutionAttempt, extras: EnvelopeExtras = {}, traceId = randomUUID()): OperationalEnvelope {
  return {
    campaignId,
    assessmentRunId: attempt.assessmentRunId,
    runStepId: attempt.runStepId,
    leaseGeneration: attempt.leaseGeneration,
    executionAttemptId: attempt.executionAttemptId,
    effectId: attempt.effectId,
    engineRequestId: attempt.engineRequestId,
    probeAttemptId: extras.probeAttemptId ?? null,
    observationId: extras.observationId ?? null,
    eventSequence: extras.eventSequence ?? null,
    worldGeneration: extras.worldGeneration ?? null,
    worldEpoch: extras.worldEpoch ?? null,
    modelDigest: extras.modelDigest ?? null,
    traceId,
  };
}

export interface EnvelopeSink {
  emit(envelope: OperationalEnvelope): void;
}

export interface EmitResult {
  readonly emitted: boolean;
  readonly error?: string;
}

/**
 * §11: "telemetry failure does not change the Verdict and does not block canonical
 * commit." This is the one place an `OperationalEnvelope` is ever handed to a
 * sink — a throwing sink is caught and reported here, never propagated, so nothing
 * upstream of a call site that also does canonical work can have that work
 * interrupted by a telemetry failure. See
 * `redteam.execution/telemetry-is-not-authority`'s test for the direct proof: a
 * sink that always throws still leaves `commitFencedObservation()`'s outcome
 * completely unaffected.
 */
export function safeEmit(sink: EnvelopeSink, envelope: OperationalEnvelope): EmitResult {
  try {
    sink.emit(envelope);
    return { emitted: true };
  } catch (err) {
    return { emitted: false, error: err instanceof Error ? err.message : String(err) };
  }
}
