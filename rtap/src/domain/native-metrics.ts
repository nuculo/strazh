/**
 * ARCHITECTURE.md §6: "Native metrics namespaced и не усредняются."
 * redteam.score/native-scores-are-never-averaged.
 */

export interface NativeMetric {
  readonly namespace: 'promptfoo' | 'duo' | 'frozen';
  readonly name: string;
  readonly value: number;
}

/**
 * Groups metrics by namespace without ever combining values across namespaces. There is
 * deliberately no function anywhere in this module that returns a single cross-namespace
 * number — that function must not exist, not just "not be called".
 */
export function groupNativeMetricsByNamespace(metrics: readonly NativeMetric[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const metric of metrics) {
    const bucket = groups.get(metric.namespace) ?? [];
    bucket.push(metric.value);
    groups.set(metric.namespace, bucket);
  }
  return groups;
}
