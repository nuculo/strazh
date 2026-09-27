/**
 * duo-agents' real LLM redteam output shape. Field names verified against
 * `duo-agents/src/redteam/mod.rs` (`AttackCase`, `GradeResult`, `TestResult`,
 * `RedteamReport`) and `duo-agents/src/redteam/scoring.rs` (`PluginRiskScore`,
 * `StrategyScore`, `RiskComponents`, `SystemRiskScore`, `RiskDistribution`), and
 * against a real captured report (`test/fixtures/duo-llm-redteam-report.json`,
 * produced by actually running `duo-agents redteam --format json -o ...` — not
 * hand-written, same discipline as duo-static's real gitlabhq scan fixture). No
 * `demo_report.json`-style shortcuts: that file is cosmetic dashboard dressing
 * generated from static-scan data by a throwaway script
 * (`duo-agents/scripts/convert_demo.py`), not real redteam output, and was not used
 * here.
 *
 * ARCHITECTURE.md §9 Phase R names four gates before this harness may be trusted:
 * a real TargetProvider, strategies/domains actually wired in, mandatory grading
 * (or explicit UNVERIFIED), and deterministic scoring with a versioned DTO. None
 * hold today — see run.ts's `DECLARED_CAPABILITIES` and parse.ts's doc comment for
 * exactly what each field below can and cannot be trusted for:
 *
 * - There is no TargetProvider. `response` is `simulate_ai_response()`
 *   (`redteam/mod.rs:311-325`), a private 4-branch keyword-matched string — never a
 *   real model call. `duo-agents/Cargo.toml` declares `reqwest`, but `src/redteam/`
 *   never imports it.
 * - `strategy_id` is always `null` in every real capture regardless of the
 *   `--strategies`/`--domains` CLI flags passed — `RedteamConfig.strategies` and
 *   `.domains` are populated from CLI input and then never read by `run_redteam()`.
 *   `amplify_attacks()` (the function that would apply a strategy to a base attack)
 *   has exactly one occurrence in the whole crate: its own definition.
 * - `grade.reason === 'No grader found, defaulting to pass'` (the literal sentinel
 *   `graders::all_graders()`'s fallback emits, `redteam/mod.rs`) means exactly what
 *   it says: no grading happened at all, `grade.pass`/`grade.score` are not a
 *   verdict on anything, and parse.ts treats this string as the detection signal
 *   for "ungraded" rather than trusting `pass`/`score` at face value. Only 4 of the
 *   18 attack plugins have a real grader (`data-exfil`, `cross-session-leak`,
 *   `reasoning-dos`, `ascii-smuggling`, all in `graders/deterministic.rs`) —
 *   substring/keyword counting, not an LLM judge or human review.
 * - No field anywhere in these types carries a schema/format version.
 * - `PluginRiskScore.worst_strategy` is a known non-deterministic tie-break output
 *   of a `HashMap` iteration + `max_by` in `scoring.rs` (Rust's `HashMap` uses a
 *   randomized `RandomState` per process) — deliberately not consumed by parse.ts.
 */
export type DuoLlmSeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational';

/** Distinct from `DuoLlmSeverity` in the real code (`RiskLevel`, `scoring.rs`) despite sharing variant names — not the same enum, not interchangeable. */
export type DuoLlmRiskLevel = 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational';

export interface DuoLlmAttackCase {
  readonly plugin_id: string;
  readonly strategy_id: string | null;
  readonly prompt: string;
  readonly expected_behavior: string;
  readonly metadata: Record<string, string>;
}

export interface DuoLlmGradeResult {
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
}

export interface DuoLlmTestResult {
  readonly attack: DuoLlmAttackCase;
  readonly response: string;
  readonly grade: DuoLlmGradeResult;
}

export interface DuoLlmRiskComponents {
  readonly impact: number;
  readonly exploitability: number;
  readonly human_factor: number;
  readonly strategy_weight: number;
}

export interface DuoLlmStrategyScore {
  readonly strategy: string;
  readonly score: number;
  readonly success_rate: number;
}

export interface DuoLlmPluginRiskScore {
  readonly plugin_id: string;
  readonly severity: DuoLlmSeverity;
  readonly score: number;
  readonly level: DuoLlmRiskLevel;
  readonly complexity_score: number;
  /** Non-deterministic tie-break output — see module doc comment. Never consumed. */
  readonly worst_strategy: string;
  readonly strategy_breakdown: DuoLlmStrategyScore[];
  readonly components: DuoLlmRiskComponents;
}

export interface DuoLlmRiskDistribution {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly informational: number;
}

export interface DuoLlmSystemRiskScore {
  readonly score: number;
  readonly level: DuoLlmRiskLevel;
  readonly distribution: DuoLlmRiskDistribution;
  readonly components: DuoLlmRiskComponents;
}

export interface DuoLlmRedteamReport {
  readonly id: string;
  readonly timestamp: string;
  readonly purpose: string;
  readonly duration_ms: number;
  readonly results: DuoLlmTestResult[];
  readonly plugin_scores: DuoLlmPluginRiskScore[];
  readonly system_score: DuoLlmSystemRiskScore;
}

/** The exact, literal fallback string that means "not actually graded" — see module doc comment. */
export const UNGRADED_SENTINEL = 'No grader found, defaulting to pass';
