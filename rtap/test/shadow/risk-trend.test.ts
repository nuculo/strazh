import { describe, expect, it } from 'vitest';
import { validate } from '../../src/schemas/index.js';
import { computeRiskTrend, type RiskTrendObservation } from '../../src/shadow/risk-trend.js';

const world = { worldGeneration: 0, worldEpoch: 10 };

function obsAt(id: string, occurredAt: string, value: number): RiskTrendObservation {
  return { id, occurredAt, nativeMetrics: [{ namespace: 'duo', name: 'severity', value }] };
}

describe('computeRiskTrend', () => {
  it('reports insufficient-data with fewer than two data points', () => {
    const signal = computeRiskTrend('target-1', [obsAt('o1', '2026-08-01T00:00:00Z', 5)], 'duo', 'severity', world);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes).toEqual(['insufficient-data']);
  });

  it('reports risk-increasing with a positive value when the recent window average is higher', () => {
    const observations = [
      obsAt('o1', '2026-08-01T00:00:00Z', 1),
      obsAt('o2', '2026-08-02T00:00:00Z', 1),
      obsAt('o3', '2026-08-03T00:00:00Z', 9),
      obsAt('o4', '2026-08-04T00:00:00Z', 9),
    ];
    const signal = computeRiskTrend('target-1', observations, 'duo', 'severity', world);
    expect(signal.value).toBeGreaterThan(0);
    expect(signal.reasonCodes[0]).toBe('risk-increasing');
    expect(signal.kind).toBe('RISK_TREND');
  });

  it('reports risk-decreasing with a negative value when the recent window average is lower', () => {
    const observations = [
      obsAt('o1', '2026-08-01T00:00:00Z', 9),
      obsAt('o2', '2026-08-02T00:00:00Z', 9),
      obsAt('o3', '2026-08-03T00:00:00Z', 1),
      obsAt('o4', '2026-08-04T00:00:00Z', 1),
    ];
    const signal = computeRiskTrend('target-1', observations, 'duo', 'severity', world);
    expect(signal.value).toBeLessThan(0);
    expect(signal.reasonCodes[0]).toBe('risk-decreasing');
  });

  it('reports risk-stable when the average does not change', () => {
    const observations = [
      obsAt('o1', '2026-08-01T00:00:00Z', 5),
      obsAt('o2', '2026-08-02T00:00:00Z', 5),
      obsAt('o3', '2026-08-03T00:00:00Z', 5),
      obsAt('o4', '2026-08-04T00:00:00Z', 5),
    ];
    const signal = computeRiskTrend('target-1', observations, 'duo', 'severity', world);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes[0]).toBe('risk-stable');
  });

  it('never mixes metrics from a different namespace or a different name', () => {
    const observations: RiskTrendObservation[] = [
      { id: 'o1', occurredAt: '2026-08-01T00:00:00Z', nativeMetrics: [{ namespace: 'duo', name: 'severity', value: 1 }] },
      { id: 'o2', occurredAt: '2026-08-02T00:00:00Z', nativeMetrics: [{ namespace: 'duo', name: 'other-metric', value: 999 }] },
      { id: 'o3', occurredAt: '2026-08-03T00:00:00Z', nativeMetrics: [{ namespace: 'promptfoo', name: 'severity', value: 999 }] },
      { id: 'o4', occurredAt: '2026-08-04T00:00:00Z', nativeMetrics: [{ namespace: 'duo', name: 'severity', value: 1 }] },
    ];
    const signal = computeRiskTrend('target-1', observations, 'duo', 'severity', world);
    // Only o1/o4 match namespace 'duo' + name 'severity' — two points, both value 1: stable, not influenced by the 999s.
    expect(signal.reasonCodes[0]).toBe('risk-stable');
    expect(signal.evidenceObservationIds.sort()).toEqual(['o1', 'o4']);
  });

  it('sorts points by occurredAt regardless of input order', () => {
    const observations = [obsAt('later', '2026-08-04T00:00:00Z', 9), obsAt('earlier', '2026-08-01T00:00:00Z', 1)];
    const signal = computeRiskTrend('target-1', observations, 'duo', 'severity', world);
    expect(signal.value).toBeGreaterThan(0); // earlier(1) -> later(9), correctly ordered despite input order
  });

  it('produces a schema-valid FrozenSignal', () => {
    const observations = [obsAt('o1', '2026-08-01T00:00:00Z', 1), obsAt('o2', '2026-08-02T00:00:00Z', 9)];
    const signal = computeRiskTrend('target-1', observations, 'duo', 'severity', world);
    const check = validate('rtap:frozen-signal', signal);
    expect(check.valid, check.errors.join('; ')).toBe(true);
  });
});
