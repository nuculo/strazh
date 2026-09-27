/**
 * EXECUTION_SAFETY_RECOVERY.md §11's seven named minimum operational metrics,
 * verbatim. This is the contract only — a typed name registry plus an injectable
 * recorder interface, not a Prometheus (or any other) exporter, since no metrics
 * backend exists in this repo to export to. `InMemoryMetricsRecorder` exists for
 * tests, not as a production implementation.
 */
export const OPERATIONAL_METRICS = {
  executionAttemptsTotal: 'rtap_execution_attempts_total',
  unknownEffectOutcomesTotal: 'rtap_unknown_effect_outcomes_total',
  staleLeaseResultsTotal: 'rtap_stale_lease_results_total',
  effectReconciliationDurationSeconds: 'rtap_effect_reconciliation_duration_seconds',
  schedulerBarrierWaitSeconds: 'rtap_scheduler_barrier_wait_seconds',
  observationCommitLatencySeconds: 'rtap_observation_commit_latency_seconds',
  outboxLagSeconds: 'rtap_outbox_lag_seconds',
} as const;

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsRecorder {
  incrementCounter(metric: string, labels: MetricLabels): void;
  observeHistogram(metric: string, valueSeconds: number, labels: MetricLabels): void;
}

/** A no-op recorder is the correct default everywhere a `MetricsRecorder` is accepted — §11: metrics are observability, never authority, so their absence must never change behavior. */
export const NOOP_METRICS_RECORDER: MetricsRecorder = {
  incrementCounter: () => {},
  observeHistogram: () => {},
};

export interface RecordedMetric {
  readonly metric: string;
  readonly kind: 'counter' | 'histogram';
  readonly value: number;
  readonly labels: MetricLabels;
}

/** Reference implementation for tests — records every call, in order, for assertion. Not a production backend. */
export class InMemoryMetricsRecorder implements MetricsRecorder {
  readonly recorded: RecordedMetric[] = [];

  incrementCounter(metric: string, labels: MetricLabels): void {
    this.recorded.push({ metric, kind: 'counter', value: 1, labels });
  }

  observeHistogram(metric: string, valueSeconds: number, labels: MetricLabels): void {
    this.recorded.push({ metric, kind: 'histogram', value: valueSeconds, labels });
  }
}
