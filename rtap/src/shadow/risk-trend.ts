import { createHash } from 'node:crypto';
import type { NativeMetric } from '../domain/native-metrics.js';
import type { WorldPosition, FrozenSignal } from './signal.js';

export const RISK_TREND_MODEL_REF = 'deterministic:risk-trend-v1';

export interface RiskTrendObservation {
  readonly id: string;
  readonly occurredAt: string;
  readonly nativeMetrics?: readonly NativeMetric[];
}

function digestOfIds(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join(',')).digest('hex');
}

/**
 * FROZEN_INTEGRATION.md §5.4 `RISK_TREND`: "deterministic time-series aggregation
 * of native risk scores ... CampaignWorld event history — no model required."
 * Checked before writing this: the actual source is committed *Observations*, not
 * `CampaignEvent` payloads — `pipeline/observation-event.ts`'s
 * `eventForObservation()` only carries `{targetId, probeId, verdict}` into the
 * committed event, never `nativeMetrics` (`domain/native-metrics.ts`), so a
 * `CampaignEvent` has no native-metric history to aggregate at all.
 * `ObservationRecord`'s `[key: string]: unknown` index signature round-trips
 * whatever an adapter attached — `nativeMetrics` included — through `body_json`,
 * which is why this reads Observations instead. `groupNativeMetricsByNamespace()`'s
 * own rule — never average across namespaces — still applies: a caller picks one
 * `namespace`+`name` pair per call; this never mixes them itself.
 *
 * Splits the ordered points into two consecutive equal-size windows (same
 * "recent vs. previous," not "recent vs. lifetime average," reasoning as
 * `shadow/saturation.ts`) and reports the difference of their means. Positive
 * `value` means risk increasing, negative means decreasing — deliberately signed,
 * unlike `PROBE_UTILITY`'s implicit "higher is more useful" convention, since a
 * trend has a real direction a magnitude-only score would hide.
 */
export function computeRiskTrend(
  targetId: string,
  observations: readonly RiskTrendObservation[],
  namespace: NativeMetric['namespace'],
  metricName: string,
  world: WorldPosition,
  quality: FrozenSignal['quality'] = 'SHADOW',
): FrozenSignal {
  const points = observations
    .flatMap((o) => (o.nativeMetrics ?? []).filter((m) => m.namespace === namespace && m.name === metricName).map((m) => ({ occurredAt: o.occurredAt, value: m.value, id: o.id })))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const base = {
    kind: 'RISK_TREND' as const,
    subjectRef: targetId,
    targetId,
    quality,
    modelRef: RISK_TREND_MODEL_REF,
    adapterRef: null,
    worldGeneration: world.worldGeneration,
    worldEpoch: world.worldEpoch,
  };

  if (points.length < 2) {
    const evidenceObservationIds = points.map((p) => p.id);
    return { ...base, value: 0, reasonCodes: ['insufficient-data'], evidenceObservationIds, featureSnapshotRef: `observations:${digestOfIds(evidenceObservationIds)}` };
  }

  const windowSize = Math.max(1, Math.floor(points.length / 2));
  const earlier = points.slice(0, windowSize);
  const recent = points.slice(points.length - windowSize);
  const avg = (arr: typeof points): number => arr.reduce((s, p) => s + p.value, 0) / arr.length;
  const earlierAvg = avg(earlier);
  const recentAvg = avg(recent);
  const trend = recentAvg - earlierAvg;
  const direction = trend > 0 ? 'risk-increasing' : trend < 0 ? 'risk-decreasing' : 'risk-stable';
  const evidenceObservationIds = points.map((p) => p.id);

  return {
    ...base,
    value: trend,
    reasonCodes: [direction, `earlier-window-avg:${earlierAvg.toFixed(3)}`, `recent-window-avg:${recentAvg.toFixed(3)}`, `namespace:${namespace}`, `metric:${metricName}`],
    evidenceObservationIds,
    featureSnapshotRef: `observations:${digestOfIds(evidenceObservationIds)}`,
  };
}
