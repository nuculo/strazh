/**
 * ARCHITECTURE.md §9 Phase R's four gates before `DuoLlmAdapter` may be enabled:
 * a real TargetProvider, strategies/domains connected, mandatory grading, and
 * deterministic scoring. This is the generic mechanism that turns those from prose
 * into an enforced check any EngineAdapter can declare against — not hardcoded to
 * duo-llm, so a future adapter with its own unmet preconditions reuses the same
 * gate instead of inventing another ad hoc "is this thing allowed to run" check.
 *
 * Implements `redteam.adapter/unsupported-capability-is-rejected`
 * (src/laws/catalog/platform.laws.ts), pending since Phase 0 for lack of any
 * capability matrix to check against — `DuoLlmAdapter` (adapters/duo-llm/run.ts)
 * is the first real adapter this actually gates.
 */
export type EngineAdapterCapability = 'realTargetProvider' | 'strategiesConnected' | 'mandatoryGrading' | 'deterministicScoring';

export type EngineAdapterCapabilities = Readonly<Record<EngineAdapterCapability, boolean>>;

export interface CapabilityCheck {
  readonly permitted: boolean;
  readonly missing: readonly EngineAdapterCapability[];
}

/**
 * Pure. Checked before dispatch, not discovered as a runtime failure — callers must
 * call this before invoking anything that talks to the underlying engine, never
 * after, or the "before execution" half of the law's statement is meaningless.
 */
export function checkCapabilities(declared: EngineAdapterCapabilities, required: readonly EngineAdapterCapability[]): CapabilityCheck {
  const missing = required.filter((capability) => !declared[capability]);
  return { permitted: missing.length === 0, missing };
}
