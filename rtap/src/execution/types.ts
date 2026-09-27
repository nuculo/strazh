/**
 * EXECUTION_SAFETY_RECOVERY.md §4.2's `ExecutionAttempt`. Same convention as
 * `runsteps/types.ts`'s `RunStep`: no separate JSON Schema file — like `RunStep`,
 * this is an internal Control Plane durability record, not a wire object exchanged
 * with an engine, so a well-typed interface plus the DB schema is the "schema"
 * §16's delivery sequence asks for, not a `*.schema.json` file.
 *
 * Phase 4.5 is delivered in the doc's own four numbered sub-phases (§16); this is
 * 4.5.1 — Identity and fencing only. Fields below that belong to 4.5.2/4.5.3/4.5.4
 * (`effectId`, `policySnapshotRef`, `targetSnapshotRef`, `interceptorPlanGeneration`,
 * `concurrencyClass`) are structurally present because §4.2 defines them as part of
 * the one `ExecutionAttempt` struct, but nothing in 4.5.1 enforces them yet — they
 * are accepted from the caller and stored, not validated or acted on. See
 * rtap/README.md's Phase 4.5 section for exactly what is and isn't enforced.
 */
export type ConcurrencyClass = 'READ_ONLY_PARALLEL' | 'TARGET_SERIAL' | 'CAMPAIGN_SERIAL' | 'EXCLUSIVE' | 'UNKNOWN';

/**
 * §5.3's full terminal-reason taxonomy, defined here in one place even though
 * 4.5.1's own code only ever sets `COMPLETED`/`CANCELLED` — the rest
 * (`AUTHORIZATION_DENIED`, `UNKNOWN_EFFECT_OUTCOME`, ...) belong to the effect
 * commit protocol 4.5.2 introduces, and reuse this same field on the same struct.
 */
export type TerminalReason =
  | 'COMPLETED'
  | 'CANCELLED'
  | 'TIMED_OUT_BEFORE_EFFECT'
  | 'AUTHORIZATION_DENIED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'TARGET_UNAVAILABLE'
  | 'FAILED_BEFORE_EFFECT'
  | 'UNKNOWN_EFFECT_OUTCOME'
  | 'NORMALIZATION_FAILED'
  | 'STALE_LEASE_RESULT'
  | 'OBSERVATION_COMMITTED';

export interface ExecutionAttempt {
  readonly executionAttemptId: string;
  readonly assessmentRunId: string;
  /** ARCH_CLAUDE_TRANSFER.md §2.5 — copied from the RunStep at `start()` time, the same way `leaseGeneration`/`attemptNo` already are. `null` for every attempt whose RunStep predates or never carried an identity. */
  readonly campaignId: string | null;
  readonly targetId: string | null;
  readonly runStepId: string;
  readonly leaseGeneration: number;
  readonly attemptNo: number;
  readonly engineAdapterId: string;
  readonly engineAdapterVersion: string;
  readonly engineRequestId: string;
  readonly effectId: string | null;
  readonly policySnapshotRef: string | null;
  readonly targetSnapshotRef: string | null;
  readonly interceptorPlanGeneration: number | null;
  readonly concurrencyClass: ConcurrencyClass;
  readonly startedAt: string;
  readonly terminalReason: TerminalReason | null;
  readonly terminatedAt: string | null;
}

export interface StartAttemptInput {
  readonly assessmentRunId: string;
  readonly runStepId: string;
  readonly engineAdapterId: string;
  readonly engineAdapterVersion: string;
  readonly engineRequestId: string;
  readonly policySnapshotRef?: string | null;
  readonly targetSnapshotRef?: string | null;
  /** Defaults to `'UNKNOWN'` — §9's "undeclared concurrency normalizes to EXCLUSIVE" rule belongs to the 4.5.3 scheduler, not enforced here. */
  readonly concurrencyClass?: ConcurrencyClass;
  /**
   * §10: "plan generation enters ExecutionAttempt." The `InterceptorPlan.planGeneration`
   * a caller compiled and is dispatching under — null when no plan was compiled.
   *
   * §2.1–2.3 (`ARCH_CLAUDE_TRANSFER.md`) built a real production dispatch loop
   * (`admitDispatch() -> executeLeasedStep() -> commitFencedObservation()`), so "no
   * dispatch loop exists" stopped being why this stays null. The actual reason,
   * checked by грань №10's resonance refresh (`Грани Arch_claude`): zero concrete
   * `InterceptorDescriptor`s exist anywhere in this repo — `compilePlan()` and
   * `evaluateStageOutcomes()` (`interceptor.ts`) are exercised only by their own
   * law/tests. Wiring `compilePlan()` into the real loop today would compile an
   * always-empty descriptor list into every attempt — a non-null `planGeneration`
   * with nothing behind it to enforce, and `evaluateStageOutcomes()` would still
   * have no call site collecting real stage outcomes to check. Deliberately
   * deferred until real interceptors exist to compile, not an oversight.
   */
  readonly interceptorPlanGeneration?: number | null;
}

/** §7.2's fencing algorithm, points 1–5 (points 6–8 belong to 4.5.2/4.5.3 — authorization revocation and artifact digest — and to the existing idempotent-commit dedup already enforced by `commitObservationWithEvent`). */
export type FencingRejectionReason =
  | 'RUN_STEP_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_BELONGS_TO_DIFFERENT_STEP'
  | 'ATTEMPT_ALREADY_TERMINAL'
  | 'STALE_LEASE_RESULT';

export interface NativeResultBinding {
  readonly runStepId: string;
  readonly executionAttemptId: string;
  /** A reference to the persisted native artifact — e.g. an ArtifactStore ref (Phase 7). Not itself validated here; §7.2 point 7 (digest match) is a 4.5.2+ concern. */
  readonly nativeResultRef: string;
}

export interface BindResult {
  readonly permitted: boolean;
  readonly reason?: FencingRejectionReason;
}

export interface QuarantineEntry {
  readonly runStepId: string;
  readonly executionAttemptId: string | null;
  readonly nativeResultRef: string;
  readonly reason: FencingRejectionReason;
  readonly quarantinedAt: string;
}
