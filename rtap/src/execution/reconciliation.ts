import type { EffectCapability } from './effect.js';
import type { TerminalReason } from './types.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §12's recovery flowchart, as a pure function. The
 * five actions below are exactly the flowchart's five terminal nodes (I, Q, M, U,
 * K) — nothing here performs the retry, query, or compensation itself; a caller
 * (`EffectReconciler`) does that and constructs the follow-up `ReconciliationInput`.
 *
 * `effectStarted` is deliberately three-valued: §7.2/§13 are explicit that
 * "absence of an ACK does not prove absence of an effect" — the *only* way to get
 * `false` is genuine proof (an `EffectReceipt` with `outcome: FAILED_BEFORE_EFFECT`,
 * or a query that confirms absence), never merely "we found no receipt."
 */
export type ReconciliationAction =
  | 'RETRY_SAME_EFFECT' // I
  | 'QUERY_EXTERNAL_RECEIPT' // Q
  | 'RUN_COMPENSATION' // M
  | 'UNKNOWN_EFFECT_OUTCOME' // U
  | 'PROCEED_TO_NATIVE_RESULT'; // K — effect confirmed; fetch and commit through the normal path, do not retry

export interface ReconciliationDecision {
  readonly action: ReconciliationAction;
  readonly reason: string;
}

export interface ReconciliationInput {
  /** `null` = unknown/ambiguous — see module doc comment. */
  readonly effectStarted: boolean | null;
  readonly capability: EffectCapability;
  /** Only meaningful once a `QUERY_EXTERNAL_RECEIPT` decision has actually been acted on and its result is being fed back in for the follow-up decision. */
  readonly queriedReceiptOutcome?: 'CONFIRMED' | 'ABSENT' | 'STILL_UNKNOWN';
}

export function decideRecovery(input: ReconciliationInput): ReconciliationDecision {
  if (input.effectStarted === false) {
    return { action: 'RETRY_SAME_EFFECT', reason: 'proven that the effect never started — unconditionally safe to retry' };
  }

  switch (input.capability) {
    case 'IDEMPOTENT_BY_KEY':
      return { action: 'RETRY_SAME_EFFECT', reason: 'capability guarantees a safe retry with the same idempotency key, even though the original outcome is unproven' };
    case 'COMPENSATABLE':
      return { action: 'RUN_COMPENSATION', reason: 'capability requires an explicit compensation workflow rather than a retry or an unqualified unknown' };
    case 'AT_MOST_ONCE_UNPROVEN':
      return { action: 'UNKNOWN_EFFECT_OUTCOME', reason: 'capability forbids automatic retry — this is a durable business outcome requiring an operator/policy decision, not a transient exception' };
    case 'QUERYABLE_RECEIPT':
      if (input.queriedReceiptOutcome === undefined) {
        return { action: 'QUERY_EXTERNAL_RECEIPT', reason: 'capability requires querying external status before any retry decision can be made' };
      }
      switch (input.queriedReceiptOutcome) {
        case 'CONFIRMED':
          return { action: 'PROCEED_TO_NATIVE_RESULT', reason: 'external query confirmed the effect occurred — fetch and commit its result, do not retry' };
        case 'ABSENT':
          return { action: 'RETRY_SAME_EFFECT', reason: 'external query confirmed the effect never occurred — safe to retry' };
        case 'STILL_UNKNOWN':
          return { action: 'UNKNOWN_EFFECT_OUTCOME', reason: 'external query could not resolve the effect\'s status' };
      }
  }
}

/**
 * What the *interrupted* attempt's own terminal_reason should become once a
 * decision is acted on — kept separate from `decideRecovery()` so that function
 * stays a pure decision over the flowchart's nodes, not entangled with bookkeeping.
 * `RETRY_SAME_EFFECT` deliberately distinguishes proven absence
 * (`FAILED_BEFORE_EFFECT`, when `effectStarted === false`) from an unproven-but-
 * safe-to-retry case (`UNKNOWN_EFFECT_OUTCOME`, e.g. `IDEMPOTENT_BY_KEY` retrying
 * without proof) — retrying safely is not the same claim as having disproven the
 * original effect. `QUERY_EXTERNAL_RECEIPT`/`PROCEED_TO_NATIVE_RESULT` return
 * `null`: the attempt is not done yet, either more information is needed or the
 * normal fencing/commit path is about to run on it.
 */
export function terminalReasonFor(decision: ReconciliationDecision, effectStarted: boolean | null): TerminalReason | null {
  switch (decision.action) {
    case 'PROCEED_TO_NATIVE_RESULT':
    case 'QUERY_EXTERNAL_RECEIPT':
      return null;
    case 'RETRY_SAME_EFFECT':
      return effectStarted === false ? 'FAILED_BEFORE_EFFECT' : 'UNKNOWN_EFFECT_OUTCOME';
    case 'RUN_COMPENSATION':
    case 'UNKNOWN_EFFECT_OUTCOME':
      return 'UNKNOWN_EFFECT_OUTCOME';
  }
}
