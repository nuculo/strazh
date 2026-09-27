/**
 * FeatureCompiler §4.1: "explicit about missing values". The schema requires exactly
 * 60 finite numbers (rtap:feature-snapshot), so a coordinate with no real signal yet
 * cannot be `null`/`NaN` — it gets this sentinel instead. All real, populated
 * coordinates in this Phase 2 slice are normalized to [0, 1]; MISSING sits outside
 * that range so it can never be confused with a real value by a consumer that
 * forgets to check.
 */
export const MISSING = -1;

export function isMissing(x: number): boolean {
  return x === MISSING;
}
