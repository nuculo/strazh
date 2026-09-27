import type { Action, AuthorizationDecision, AuthorizationProvider, AuthorizationRequest, Role } from './types.js';

/**
 * Additive by role — each tier is a superset of the one below, matching
 * ARCHITECTURE.md §3.4's ports being progressively more privileged: read-only,
 * then run dispatch and secret/artifact access, then model promotion and domain
 * adapter swaps (both already gated elsewhere by their own registries —
 * ModelPromotionRegistry, DomainAdapterRegistry — this is the layer in front of them).
 */
const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  VIEWER: new Set<Action>(['campaign:read', 'observation:read', 'finding:read', 'artifact:read']),
  OPERATOR: new Set<Action>([
    'campaign:read',
    'observation:read',
    'finding:read',
    'artifact:read',
    'run-step:dispatch',
    'secret:resolve',
    'artifact:write',
  ]),
  ADMIN: new Set<Action>([
    'campaign:read',
    'observation:read',
    'finding:read',
    'artifact:read',
    'run-step:dispatch',
    'secret:resolve',
    'artifact:write',
    'model:promote',
    'domain-adapter:swap',
  ]),
};

/**
 * Local profile of `AuthorizationProvider`. Tenancy is checked before role — a
 * cross-tenant request is denied even for ADMIN, because tenant isolation is a
 * boundary, not a permission a role can be granted out of. Within the same tenant,
 * the decision is the union of what the Principal's roles allow (a Principal can
 * hold more than one role).
 */
export class RoleBasedAuthorizationProvider implements AuthorizationProvider {
  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const { principal, action, resourceTenantId } = request;

    if (principal.tenantId !== resourceTenantId) {
      return { allowed: false, reason: `principal tenant ${principal.tenantId} does not match resource tenant ${resourceTenantId}` };
    }

    const allowed = principal.roles.some((role) => ROLE_ACTIONS[role].has(action));
    if (!allowed) {
      return { allowed: false, reason: `none of roles [${principal.roles.join(', ')}] permit ${action}` };
    }
    return { allowed: true, reason: `permitted by role` };
  }
}
