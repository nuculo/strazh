/**
 * FROZEN_INTEGRATION.md §11.4, ADAPTIVE_REDTEAM_RUNTIME.md §9.2, FROZEN_META_HARNESS.md
 * §10: the model promotion lifecycle. "The model cannot promote itself. Promotion
 * and demotion belong to RTAP policy and signed Model Registry metadata."
 */
export type PromotionState = 'OFF' | 'SHADOW' | 'EXPERIMENTAL' | 'CALIBRATED';

export type PromotionEvent =
  | 'MODEL_ADMITTED'
  | 'OFFLINE_AND_SHADOW_GATES_PASSED'
  | 'AB_GATES_PASSED'
  | 'DRIFT_OR_QUALITY_REGRESSION'
  | 'SAFETY_OR_COVERAGE_REGRESSION'
  | 'ARTIFACT_OR_SCHEMA_INVALID'
  | 'INTEGRITY_OR_POLICY_FAILURE';

/** The legal transition graph, taken verbatim from the documented state diagram. */
const TRANSITIONS: Record<PromotionState, Partial<Record<PromotionEvent, PromotionState>>> = {
  OFF: { MODEL_ADMITTED: 'SHADOW' },
  SHADOW: {
    OFFLINE_AND_SHADOW_GATES_PASSED: 'EXPERIMENTAL',
    ARTIFACT_OR_SCHEMA_INVALID: 'OFF',
  },
  EXPERIMENTAL: {
    AB_GATES_PASSED: 'CALIBRATED',
    SAFETY_OR_COVERAGE_REGRESSION: 'SHADOW',
  },
  CALIBRATED: {
    DRIFT_OR_QUALITY_REGRESSION: 'SHADOW',
    INTEGRITY_OR_POLICY_FAILURE: 'OFF',
  },
};

export interface TransitionResult {
  readonly allowed: boolean;
  readonly from: PromotionState;
  readonly to: PromotionState;
}

/** Pure. No event is ever silently accepted from a state that doesn't declare it — an illegal transition is rejected, not coerced to the nearest legal one. */
export function attemptTransition(from: PromotionState, event: PromotionEvent): TransitionResult {
  const to = TRANSITIONS[from]?.[event];
  if (!to) {
    return { allowed: false, from, to: from };
  }
  return { allowed: true, from, to };
}

/**
 * грань №16: a pre-computed verification outcome, passed in as data — the pure
 * functions in this file never perform I/O (resolving key material, calling
 * `node:crypto`) themselves. `reason` is populated on `verified: false`, the same
 * "explain the negative" discipline `TransitionResult`'s sibling reasons already
 * follow.
 */
export interface SignatureGate {
  readonly verified: boolean;
  readonly reason?: string;
}

export interface ModelTransitionResult extends TransitionResult {
  /** Populated only when refused specifically by the signature gate, distinct from an undeclared graph edge. */
  readonly reason?: string;
}

/**
 * Events gated by `attemptModelTransition()`, beyond legality of the state graph.
 *
 * грань №18 revises this from грань №16's original reasoning: a key-revocation
 * mechanism (`src/signing/key-store.ts`) now exists, so re-checking a fixed
 * artifact after admission is no longer pointless — but what's worth re-checking
 * is narrower than "run `SigningAuthority.verify()` again." `ModelPromotionRegistry`
 * never mutates `artifact_json` after `admit()` (no update path exists), so the
 * *cryptographic* relationship between the stored bytes and the signing key
 * cannot change after admission — a bare crypto re-verify will always return
 * exactly what it returned at `MODEL_ADMITTED`. The one fact that CAN change is
 * out-of-band: whether an operator has since revoked the key. That's a cheap
 * `SigningKeyStore` lookup, not a `SecretProvider` round-trip plus
 * `crypto.verify()` — see `promotion/cli.ts`'s `promote` subcommand, which builds
 * the two gated events' `SignatureGate`s differently (full verify for
 * `MODEL_ADMITTED`, revocation-status-only for `AB_GATES_PASSED`).
 *
 * Only `AB_GATES_PASSED` is added, not `OFFLINE_AND_SHADOW_GATES_PASSED`:
 * `authorityFor()` below shows EXPERIMENTAL -> CALIBRATED (i.e. `AB_GATES_PASSED`)
 * is the one transition where `boundedShare` flips from `true` to unbounded
 * (`false`) — the single highest-stakes authority grant in the lifecycle. A model
 * resting at SHADOW/EXPERIMENTAL/CALIBRATED with no further forward transition to
 * intercept is instead covered by `promotion/revocation-sweep.ts`'s
 * `sweepRevokedKeyDemotions()`, an operator-driven, not automatic, action — see
 * that file's doc comment for why `TRANSITIONS` below is deliberately NOT edited
 * to add a uniform demotion edge for this (it's sourced verbatim from
 * `ADAPTIVE_REDTEAM_RUNTIME.md`/`FROZEN_META_HARNESS.md`'s own diagrams, which
 * name `INTEGRITY_OR_POLICY_FAILURE -> OFF` only from CALIBRATED).
 */
const SIGNATURE_GATED_EVENTS: ReadonlySet<PromotionEvent> = new Set(['MODEL_ADMITTED', 'AB_GATES_PASSED']);

/**
 * Sits beside — not inside — `attemptTransition()`: defers to it first for graph
 * legality (unchanged, still what a bare `attemptTransition()` call tests standalone),
 * then additionally requires `signature?.verified === true` for
 * `SIGNATURE_GATED_EVENTS` only. Reject, never coerce — same contract as
 * `attemptTransition()`, extended rather than replaced.
 */
export function attemptModelTransition(from: PromotionState, event: PromotionEvent, signature?: SignatureGate): ModelTransitionResult {
  const graphResult = attemptTransition(from, event);
  if (!graphResult.allowed) {
    return graphResult;
  }
  if (SIGNATURE_GATED_EVENTS.has(event) && signature?.verified !== true) {
    return {
      allowed: false,
      from,
      to: from,
      reason: signature ? (signature.reason ?? 'signature does not verify') : `${event} requires a verified SignatureGate, none was provided`,
    };
  }
  return graphResult;
}

/** What a given promotion state authorizes the Planner to do — the other half of the table in §10. */
export interface PromotionAuthority {
  readonly rankAndLogCandidates: boolean;
  readonly influencesRunStepCreation: boolean;
  readonly boundedShare: boolean;
}

export function authorityFor(state: PromotionState): PromotionAuthority {
  switch (state) {
    case 'OFF':
      return { rankAndLogCandidates: false, influencesRunStepCreation: false, boundedShare: false };
    case 'SHADOW':
      return { rankAndLogCandidates: true, influencesRunStepCreation: false, boundedShare: false };
    case 'EXPERIMENTAL':
      return { rankAndLogCandidates: true, influencesRunStepCreation: true, boundedShare: true };
    case 'CALIBRATED':
      return { rankAndLogCandidates: true, influencesRunStepCreation: true, boundedShare: false };
  }
}
