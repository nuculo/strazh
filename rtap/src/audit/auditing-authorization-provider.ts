import type { AuthorizationDecision, AuthorizationProvider, AuthorizationRequest } from '../authz/types.js';
import type { AuditLog } from './log.js';

/**
 * Decorates any `AuthorizationProvider` so every decision — allowed or denied — is
 * recorded to `AuditLog` before it is returned. Ties Phase 7's "RBAC, tenancy,
 * audit" together as one path instead of three unconnected pieces: nothing can call
 * `authorize()` through this wrapper and have the decision go unaudited, including
 * denials, which matter at least as much as grants for an audit trail.
 */
export class AuditingAuthorizationProvider implements AuthorizationProvider {
  constructor(
    private readonly inner: AuthorizationProvider,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const decision = this.inner.authorize(request);
    this.audit.record(
      {
        tenantId: request.principal.tenantId,
        subjectId: request.principal.subjectId,
        action: request.action,
        resourceTenantId: request.resourceTenantId,
        allowed: decision.allowed,
        reason: decision.reason,
      },
      this.now(),
    );
    return decision;
  }
}
