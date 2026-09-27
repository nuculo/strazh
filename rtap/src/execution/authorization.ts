import type { AuthorizationProvider, Principal } from '../authz/types.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §8 — capability authorization. §8.1's
 * `AuthorizationReceipt` struct, verbatim field-for-field. `adapterIdentity` is
 * split into id/version (matching `ExecutionAttempt.engineAdapterId/Version` from
 * 4.5.1) rather than a single opaque string, so "adapter version/capability digest
 * mismatch requires new authorization" (§8's rules) is a direct field comparison.
 */
export interface AdapterIdentity {
  readonly engineAdapterId: string;
  readonly engineAdapterVersion: string;
}

export interface AuthorizationReceipt {
  readonly authorizationId: string;
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly runStepId: string;
  readonly operationFamily: string;
  readonly targetSnapshotRef: string;
  readonly adapterIdentity: AdapterIdentity;
  readonly adapterCapabilityDigest: string;
  readonly policyRevision: string;
  readonly sandboxProfileRef: string | null;
  readonly egressPolicyRef: string | null;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

/**
 * §8's pipeline: Schema validation -> Adapter capability validation -> RTAP policy
 * authorization -> Sandbox and egress constraints -> AuthorizationReceipt. "RTAP
 * policy authorization" (P) is `AuthorizationProvider` — ARCHITECTURE.md §3.4's
 * port, implemented in Phase 7 — reused here rather than duplicated: this pipeline
 * gates the exact `'run-step:dispatch'` action Phase 7 already named.
 */
export interface AuthorizeEffectRequest {
  readonly principal: Principal;
  readonly resourceTenantId: string;
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly runStepId: string;
  readonly operationFamily: string;
  readonly targetSnapshotRef: string;
  readonly adapterIdentity: AdapterIdentity;
  readonly declaredCapabilityDigest: string;
  readonly expectedCapabilityDigest: string;
  readonly policyRevision: string;
  readonly sandboxProfileRef: string | null;
  readonly egressPolicyRef: string | null;
  readonly receiptDurationMs: number;
}

export type AuthorizationRejectionReason =
  | 'MALFORMED_REQUEST'
  | 'CAPABILITY_DIGEST_MISMATCH'
  | 'POLICY_DENIED'
  | 'SANDBOX_OR_EGRESS_POLICY_MISSING';

export type EffectAuthorizationResult =
  | { readonly authorized: true; readonly receipt: AuthorizationReceipt }
  | { readonly authorized: false; readonly reason: AuthorizationRejectionReason; readonly detail: string };

/**
 * Fail-closed at every stage: any stage that cannot be evaluated as an explicit
 * pass is treated as a rejection, never defaulted to allow. `authorizationId`/`now`
 * are injectable the same way `ExecutionAttemptStore.start()`'s id/now are, for
 * deterministic tests.
 */
export function evaluateAuthorization(
  request: AuthorizeEffectRequest,
  authorizationProvider: AuthorizationProvider,
  now = new Date(),
  authorizationId = `authz-${request.runStepId}-${now.getTime()}`,
): EffectAuthorizationResult {
  // V — schema validation: the structural minimum a request must carry.
  if (
    request.campaignId.length === 0 ||
    request.assessmentRunId.length === 0 ||
    request.runStepId.length === 0 ||
    request.operationFamily.length === 0 ||
    request.targetSnapshotRef.length === 0 ||
    request.adapterIdentity.engineAdapterId.length === 0 ||
    request.adapterIdentity.engineAdapterVersion.length === 0 ||
    request.policyRevision.length === 0
  ) {
    return { authorized: false, reason: 'MALFORMED_REQUEST', detail: 'one or more required identity/policy fields were empty' };
  }

  // C — adapter capability validation: a digest mismatch means the adapter is not
  // the one this authorization was ever meant to cover.
  if (request.declaredCapabilityDigest !== request.expectedCapabilityDigest) {
    return {
      authorized: false,
      reason: 'CAPABILITY_DIGEST_MISMATCH',
      detail: `declared digest ${request.declaredCapabilityDigest} does not match expected ${request.expectedCapabilityDigest}`,
    };
  }

  // P — RTAP policy authorization, via the existing AuthorizationProvider port.
  const policyDecision = authorizationProvider.authorize({
    principal: request.principal,
    action: 'run-step:dispatch',
    resourceTenantId: request.resourceTenantId,
  });
  if (!policyDecision.allowed) {
    return { authorized: false, reason: 'POLICY_DENIED', detail: policyDecision.reason };
  }

  // S — sandbox and egress constraints: fail closed if either posture is undeclared.
  if (request.sandboxProfileRef === null || request.egressPolicyRef === null) {
    return { authorized: false, reason: 'SANDBOX_OR_EGRESS_POLICY_MISSING', detail: 'an effect cannot be authorized without both a sandbox profile and an egress policy declared' };
  }

  const approvedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + request.receiptDurationMs).toISOString();
  return {
    authorized: true,
    receipt: {
      authorizationId,
      campaignId: request.campaignId,
      assessmentRunId: request.assessmentRunId,
      runStepId: request.runStepId,
      operationFamily: request.operationFamily,
      targetSnapshotRef: request.targetSnapshotRef,
      adapterIdentity: request.adapterIdentity,
      adapterCapabilityDigest: request.declaredCapabilityDigest,
      policyRevision: request.policyRevision,
      sandboxProfileRef: request.sandboxProfileRef,
      egressPolicyRef: request.egressPolicyRef,
      approvedAt,
      expiresAt,
    },
  };
}

/** §8's rule: "receipt expires before effect, or is confirmed atomically at dispatch." Pure — the caller decides what "confirmed atomically" means for its own dispatch path. */
export function isReceiptValid(receipt: AuthorizationReceipt, now = new Date()): boolean {
  return now.getTime() < new Date(receipt.expiresAt).getTime();
}

/** §8's rule: adapter version/capability digest mismatch requires a new authorization — a stored receipt can never be silently reused across either changing. */
export function receiptCoversAdapter(receipt: AuthorizationReceipt, adapterIdentity: AdapterIdentity, capabilityDigest: string): boolean {
  return (
    receipt.adapterIdentity.engineAdapterId === adapterIdentity.engineAdapterId &&
    receipt.adapterIdentity.engineAdapterVersion === adapterIdentity.engineAdapterVersion &&
    receipt.adapterCapabilityDigest === capabilityDigest
  );
}
