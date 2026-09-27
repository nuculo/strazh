/**
 * EXECUTION_SAFETY_RECOVERY.md §5 — the effect commit protocol. Same pattern as
 * `promotion/types.ts`'s model-promotion state machine: a literal transition table
 * plus a pure `attemptEffectTransition()` that rejects, rather than coerces, an
 * illegal event. This is the mechanism `redteam.execution/effect-start-is-not-commit`
 * checks — with a real transition table, "EFFECT_STARTED does not equal
 * OBSERVATION_COMMITTED" isn't an assertion to remember, it's structurally true:
 * there is no single event that reaches `OBSERVATION_COMMITTED` from
 * `EFFECT_STARTED`.
 */
export type EffectLifecycleState =
  | 'ADMITTED'
  | 'AUTHORIZED'
  | 'REJECTED'
  | 'EFFECT_STARTED'
  | 'EFFECT_ACKNOWLEDGED'
  | 'UNKNOWN_EFFECT_OUTCOME'
  | 'NATIVE_RESULT_RECEIVED'
  | 'NORMALIZATION_FAILED'
  | 'RESULT_NORMALIZED'
  | 'OBSERVATION_COMMITTED'
  | 'EVENT_PUBLISHED';

export type EffectLifecycleEvent =
  | 'POLICY_AND_CAPABILITY_PASS'
  | 'ADMISSION_DENIED'
  | 'ADAPTER_DISPATCH'
  | 'EXTERNAL_RECEIPT'
  | 'CRASH_OR_LOST_ACK'
  | 'RESULT_PERSISTED'
  | 'CANNOT_RECONCILE'
  | 'SCHEMA_AND_PROVENANCE_PASS'
  | 'INVALID_NATIVE_RESULT'
  | 'ATOMIC_DOMAIN_TRANSACTION'
  | 'OUTBOX_DELIVERY';

const TRANSITIONS: Record<EffectLifecycleState, Partial<Record<EffectLifecycleEvent, EffectLifecycleState>>> = {
  ADMITTED: { POLICY_AND_CAPABILITY_PASS: 'AUTHORIZED', ADMISSION_DENIED: 'REJECTED' },
  AUTHORIZED: { ADAPTER_DISPATCH: 'EFFECT_STARTED' },
  REJECTED: {},
  EFFECT_STARTED: { EXTERNAL_RECEIPT: 'EFFECT_ACKNOWLEDGED', CRASH_OR_LOST_ACK: 'UNKNOWN_EFFECT_OUTCOME' },
  EFFECT_ACKNOWLEDGED: { RESULT_PERSISTED: 'NATIVE_RESULT_RECEIVED', CANNOT_RECONCILE: 'UNKNOWN_EFFECT_OUTCOME' },
  UNKNOWN_EFFECT_OUTCOME: {},
  NATIVE_RESULT_RECEIVED: { SCHEMA_AND_PROVENANCE_PASS: 'RESULT_NORMALIZED', INVALID_NATIVE_RESULT: 'NORMALIZATION_FAILED' },
  NORMALIZATION_FAILED: {},
  RESULT_NORMALIZED: { ATOMIC_DOMAIN_TRANSACTION: 'OBSERVATION_COMMITTED' },
  OBSERVATION_COMMITTED: { OUTBOX_DELIVERY: 'EVENT_PUBLISHED' },
  EVENT_PUBLISHED: {},
};

export const TERMINAL_EFFECT_STATES: ReadonlySet<EffectLifecycleState> = new Set(['REJECTED', 'UNKNOWN_EFFECT_OUTCOME', 'NORMALIZATION_FAILED', 'EVENT_PUBLISHED']);

export interface EffectTransitionResult {
  readonly allowed: boolean;
  readonly from: EffectLifecycleState;
  readonly to: EffectLifecycleState;
}

/** Pure. An event not declared from `from` is rejected, never coerced to the nearest legal state. */
export function attemptEffectTransition(from: EffectLifecycleState, event: EffectLifecycleEvent): EffectTransitionResult {
  const to = TRANSITIONS[from]?.[event];
  if (!to) return { allowed: false, from, to: from };
  return { allowed: true, from, to };
}

/** Every event legally reachable from `state` — for random-walk property tests, without exposing the transition table itself. */
export function legalEventsFrom(state: EffectLifecycleState): EffectLifecycleEvent[] {
  return Object.keys(TRANSITIONS[state]) as EffectLifecycleEvent[];
}

/**
 * §6's per-operation recovery capability. Distinct from
 * `adapters/capability.ts`'s `EngineAdapterCapability` — that one gates whether an
 * *adapter* is admissible to dispatch at all (Phase R); this one governs what
 * *recovery* behavior is permitted for one operation family after a crash, and
 * every adapter operation has exactly one, never zero.
 */
export type EffectCapability = 'IDEMPOTENT_BY_KEY' | 'QUERYABLE_RECEIPT' | 'COMPENSATABLE' | 'AT_MOST_ONCE_UNPROVEN';

export type EffectOutcome = 'CONFIRMED' | 'FAILED_BEFORE_EFFECT' | 'UNKNOWN';

/** §5.2. Metadata and protected references only — never a secret or raw target payload; `externalReceiptRef` may point at an encrypted native artifact. */
export interface EffectReceipt {
  readonly effectId: string;
  readonly executionAttemptId: string;
  readonly engineAdapterId: string;
  readonly engineRequestId: string;
  readonly idempotencyKey: string | null;
  readonly capability: EffectCapability;
  readonly startedAt: string;
  readonly acknowledgedAt: string | null;
  readonly externalReceiptRef: string | null;
  readonly reconciliationToken: string | null;
  readonly outcome: EffectOutcome;
}
