/**
 * FROZEN_INTEGRATION.md §4.2 coordinate groups. Both ObservationFeatureCompiler and
 * CandidateFeatureCompiler write into these same 60 slots — the *positions* are
 * shared vocabulary, the *meaning* of a position is defined per compiler (some
 * groups, like "runtime and trace", only make sense post-execution and are always
 * MISSING in a CANDIDATE view; a few in "campaign history" are populated by both).
 */
export const COORD = {
  RESPONSE_BEHAVIOR: { start: 0, count: 12 },
  GRADING: { start: 12, count: 10 },
  RUNTIME_AND_TRACE: { start: 22, count: 10 },
  PROBE_AND_STRATEGY: { start: 32, count: 10 },
  CAMPAIGN_HISTORY: { start: 42, count: 10 },
  PROVENANCE_AND_QUALITY: { start: 52, count: 8 },
} as const;

export const V60_LENGTH = 60;

/** Shared by both ObservationFeatureCompiler and CandidateFeatureCompiler — one schema version for the whole V60 family. */
export const FEATURE_SCHEMA_VERSION = '1.0.0';

export function newVector(fillValue: number): number[] {
  return Array.from({ length: V60_LENGTH }, () => fillValue);
}
