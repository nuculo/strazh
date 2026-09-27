/**
 * Architecture Law Registry — types.
 *
 * Pattern adopted from frozen's frozen-core::law (frozen/crates/frozen-core/src/law.rs)
 * and frozen-ir laws registry, per wiki/Arch_Overlay/ARCHITECTURE.md §8 and
 * wiki/Arch_Overlay/FROZEN_INTEGRATION.md §10: "Each law has stable ID, statement,
 * held_by, trials, deterministic seed, replay and a calibrated positive/counterexample
 * path. A green test without a justified statement and coverage is insufficient."
 */

export interface LawContext {
  /** Deterministic seed for this trial — same seed must reproduce the same trial input. */
  readonly seed: number;
  /** 0-based trial index within the run. */
  readonly trial: number;
}

export interface LawCheckResult {
  readonly held: boolean;
  /** Human-readable detail, required on failure, optional on success. */
  readonly detail?: string;
  /** The concrete input that falsified the law, if it did. Must be enough to replay. */
  readonly counterexample?: unknown;
}

/** `'implemented'` (held or failed) is Observed evidence; `'pending'` is Missing evidence, always with a reason — see rtap/README.md's "Evidence levels: Observed / Inferred / Missing". */
export type LawStatus = 'implemented' | 'pending';

export interface Law {
  readonly id: string;
  readonly statement: string;
  readonly status: LawStatus;
  /** Number of randomized trials to run when status is 'implemented'. Ignored otherwise. */
  readonly trials: number;
  /**
   * Why this law is still pending, when status === 'pending'. Required in that case —
   * an unstated pending law is indistinguishable from a forgotten one.
   */
  readonly pendingReason?: string;
  /**
   * The executable check. Required when status === 'implemented'. Deterministic in
   * `ctx.seed`/`ctx.trial`: the same context must always produce the same input and
   * the same verdict, so a failure can be replayed exactly.
   */
  readonly check?: (ctx: LawContext) => LawCheckResult | Promise<LawCheckResult>;
}

export interface LawTrialFailure {
  readonly trial: number;
  readonly seed: number;
  readonly detail: string;
  readonly counterexample?: unknown;
}

export interface LawRunReport {
  readonly id: string;
  readonly statement: string;
  readonly status: LawStatus;
  readonly pendingReason?: string;
  readonly trialsRun: number;
  readonly held: boolean;
  readonly failures: LawTrialFailure[];
  /** The seed the run was invoked with — replay by passing the same seed again. */
  readonly seed: number;
}

export interface RegistryReport {
  readonly total: number;
  readonly implemented: number;
  readonly pending: number;
  readonly held: number;
  readonly failed: number;
  readonly results: LawRunReport[];
}
