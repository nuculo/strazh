import { createHash } from 'node:crypto';

/**
 * EXECUTION_SAFETY_RECOVERY.md §10 — the typed `InterceptorPlan`. §10's own rule
 * list is the reason this exists as a closed, typed structure instead of a
 * function/hook registry: "arbitrary shell/HTTP hook is forbidden in the canonical
 * transaction path." `sideEffectPolicy` has no escape-hatch variant for running
 * arbitrary code — the type itself is the enforcement, not a runtime check on top
 * of an otherwise-unrestricted callback.
 */
export type InterceptorStage = 'PRE_DISPATCH' | 'POST_NATIVE_RESULT' | 'PRE_NORMALIZATION' | 'POST_OBSERVATION_COMMIT' | 'PRE_REPORT';

const STAGE_ORDER: readonly InterceptorStage[] = ['PRE_DISPATCH', 'POST_NATIVE_RESULT', 'PRE_NORMALIZATION', 'POST_OBSERVATION_COMMIT', 'PRE_REPORT'];

export type InterceptorCriticality = 'SECURITY_CRITICAL' | 'ADVISORY';

/** No `CANONICAL_MUTATION` variant is available to a `POST_OBSERVATION_COMMIT` descriptor — see `compilePlan()`'s rejection rule below, §10: "POST_OBSERVATION_COMMIT cannot roll back committed truth." */
export type SideEffectPolicy = 'NONE' | 'TELEMETRY_ONLY' | 'CANONICAL_MUTATION';

export interface InterceptorDescriptor {
  readonly interceptorId: string;
  readonly version: string;
  readonly stage: InterceptorStage;
  readonly criticality: InterceptorCriticality;
  /** Opaque schema references (e.g. a schema $id), not inlined JSON Schema — there is no concrete interceptor implementation yet to validate against. */
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly timeoutMs: number;
  readonly sideEffectPolicy: SideEffectPolicy;
}

export interface RejectedDescriptor {
  readonly descriptor: InterceptorDescriptor;
  readonly reason: string;
}

export interface InterceptorPlan {
  readonly planGeneration: number;
  readonly policySnapshotRef: string;
  readonly orderedDescriptors: readonly InterceptorDescriptor[];
  readonly rejectedDescriptors: readonly RejectedDescriptor[];
  readonly planDigest: string;
}

/**
 * Deterministic by construction: descriptors are sorted by stage (in §10's own
 * listed order) then by `interceptorId`, so the same descriptor *set* — regardless
 * of the order it was supplied in — always produces the same `orderedDescriptors`
 * and the same `planDigest`. This is what makes
 * `redteam.execution/interceptor-order-is-deterministic` true structurally rather
 * than by convention, the same way `effect.ts`'s state machine made
 * `effect-start-is-not-commit` structural in 4.5.2.
 */
export function compilePlan(planGeneration: number, policySnapshotRef: string, descriptors: readonly InterceptorDescriptor[]): InterceptorPlan {
  const accepted: InterceptorDescriptor[] = [];
  const rejected: RejectedDescriptor[] = [];

  for (const descriptor of descriptors) {
    if (descriptor.stage === 'POST_OBSERVATION_COMMIT' && descriptor.sideEffectPolicy === 'CANONICAL_MUTATION') {
      rejected.push({ descriptor, reason: 'POST_OBSERVATION_COMMIT cannot mutate canonical state — committed truth cannot be rolled back (§10)' });
      continue;
    }
    accepted.push(descriptor);
  }

  const ordered = [...accepted].sort((a, b) => {
    const stageDelta = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
    return stageDelta !== 0 ? stageDelta : a.interceptorId.localeCompare(b.interceptorId);
  });

  const digestInput = ordered.map((d) => ({ id: d.interceptorId, version: d.version, stage: d.stage, criticality: d.criticality, sideEffectPolicy: d.sideEffectPolicy }));
  const planDigest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');

  return { planGeneration, policySnapshotRef, orderedDescriptors: ordered, rejectedDescriptors: rejected, planDigest };
}

export interface InterceptorOutcome {
  readonly interceptorId: string;
  readonly ok: boolean;
  readonly diagnostic?: string;
}

export interface StageExecutionResult {
  readonly admitted: boolean;
  readonly failedCritical: readonly string[];
  readonly failedAdvisory: readonly { readonly interceptorId: string; readonly diagnostic: string }[];
}

/**
 * §10: "security-critical interceptor is fail-closed; advisory interceptor may
 * fail-open only with a typed diagnostic." A `SECURITY_CRITICAL` interceptor with
 * no reported outcome at all is treated as failed, never assumed to have passed —
 * the same fail-closed default `authorization.ts`'s pipeline uses.
 */
export function evaluateStageOutcomes(plan: InterceptorPlan, stage: InterceptorStage, outcomes: readonly InterceptorOutcome[]): StageExecutionResult {
  const relevant = plan.orderedDescriptors.filter((d) => d.stage === stage);
  const failedCritical: string[] = [];
  const failedAdvisory: { interceptorId: string; diagnostic: string }[] = [];

  for (const descriptor of relevant) {
    const outcome = outcomes.find((o) => o.interceptorId === descriptor.interceptorId);
    const ok = outcome?.ok ?? false;
    if (ok) continue;
    if (descriptor.criticality === 'SECURITY_CRITICAL') {
      failedCritical.push(descriptor.interceptorId);
    } else {
      failedAdvisory.push({ interceptorId: descriptor.interceptorId, diagnostic: outcome?.diagnostic ?? 'no diagnostic reported' });
    }
  }

  return { admitted: failedCritical.length === 0, failedCritical, failedAdvisory };
}
