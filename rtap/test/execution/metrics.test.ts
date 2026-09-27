import { describe, expect, it } from 'vitest';
import { InMemoryMetricsRecorder, NOOP_METRICS_RECORDER, OPERATIONAL_METRICS } from '../../src/execution/metrics.js';

describe('OPERATIONAL_METRICS', () => {
  it('names exactly the seven metrics §11 specifies', () => {
    expect(Object.values(OPERATIONAL_METRICS).sort()).toEqual(
      [
        'rtap_execution_attempts_total',
        'rtap_unknown_effect_outcomes_total',
        'rtap_stale_lease_results_total',
        'rtap_effect_reconciliation_duration_seconds',
        'rtap_scheduler_barrier_wait_seconds',
        'rtap_observation_commit_latency_seconds',
        'rtap_outbox_lag_seconds',
      ].sort(),
    );
  });
});

describe('NOOP_METRICS_RECORDER', () => {
  it('never throws for any call', () => {
    expect(() => NOOP_METRICS_RECORDER.incrementCounter('x', {})).not.toThrow();
    expect(() => NOOP_METRICS_RECORDER.observeHistogram('x', 1, {})).not.toThrow();
  });
});

describe('InMemoryMetricsRecorder', () => {
  it('records counters and histograms in call order', () => {
    const recorder = new InMemoryMetricsRecorder();
    recorder.incrementCounter(OPERATIONAL_METRICS.executionAttemptsTotal, { adapter: 'promptfoo', terminal_reason: 'COMPLETED' });
    recorder.observeHistogram(OPERATIONAL_METRICS.observationCommitLatencySeconds, 0.42, { adapter: 'promptfoo' });

    expect(recorder.recorded).toEqual([
      { metric: 'rtap_execution_attempts_total', kind: 'counter', value: 1, labels: { adapter: 'promptfoo', terminal_reason: 'COMPLETED' } },
      { metric: 'rtap_observation_commit_latency_seconds', kind: 'histogram', value: 0.42, labels: { adapter: 'promptfoo' } },
    ]);
  });
});
