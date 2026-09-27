/**
 * ARCHITECTURE.md §3.4's `AuthorizationProvider` port, and the Phase 7 roadmap's
 * "RBAC, tenancy" bullet — neither implemented before this. Every action a Principal
 * can take is named explicitly rather than left as a free-form string, so a new
 * call site cannot silently invent an unchecked action.
 */
export type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';

export type Action =
  | 'campaign:read'
  | 'observation:read'
  | 'finding:read'
  | 'run-step:dispatch'
  | 'model:promote'
  | 'domain-adapter:swap'
  | 'secret:resolve'
  | 'artifact:read'
  | 'artifact:write';

export interface Principal {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
}

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly action: Action;
  /** The tenant that owns the resource being acted on. */
  readonly resourceTenantId: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Synchronous by design: this is a pure policy decision over an already-resolved
 * Principal (roles/tenant), not an identity lookup — the same reasoning
 * ArtifactStore/SecretProvider are async for (real I/O) argues the other way here,
 * since a real PDP evaluates already-issued claims rather than calling out per check.
 */
export interface AuthorizationProvider {
  authorize(request: AuthorizationRequest): AuthorizationDecision;
}
