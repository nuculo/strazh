import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { AuditLog } from '../../src/audit/log.js';
import { AuditingAuthorizationProvider } from '../../src/audit/auditing-authorization-provider.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import type { Principal } from '../../src/authz/types.js';

describe('AuditingAuthorizationProvider', () => {
  it('returns the inner decision unchanged and records an allowed decision', () => {
    const audit = new AuditLog(openInMemoryDatabase());
    const auditing = new AuditingAuthorizationProvider(new RoleBasedAuthorizationProvider(), audit);
    const principal: Principal = { subjectId: 's1', tenantId: 't1', roles: ['ADMIN'] };

    const decision = auditing.authorize({ principal, action: 'model:promote', resourceTenantId: 't1' });
    expect(decision.allowed).toBe(true);

    const entries = audit.listByTenant('t1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ subjectId: 's1', action: 'model:promote', resourceTenantId: 't1', allowed: true });
  });

  it('records a denied decision too, not only allowed ones', () => {
    const audit = new AuditLog(openInMemoryDatabase());
    const auditing = new AuditingAuthorizationProvider(new RoleBasedAuthorizationProvider(), audit);
    const principal: Principal = { subjectId: 's1', tenantId: 't1', roles: ['VIEWER'] };

    const decision = auditing.authorize({ principal, action: 'model:promote', resourceTenantId: 't1' });
    expect(decision.allowed).toBe(false);

    const entries = audit.listByTenant('t1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ allowed: false });
  });

  it('records a cross-tenant denial under the principal\'s own tenant', () => {
    const audit = new AuditLog(openInMemoryDatabase());
    const auditing = new AuditingAuthorizationProvider(new RoleBasedAuthorizationProvider(), audit);
    const principal: Principal = { subjectId: 's1', tenantId: 't1', roles: ['ADMIN'] };

    auditing.authorize({ principal, action: 'model:promote', resourceTenantId: 't2' });

    expect(audit.listByTenant('t1')).toHaveLength(1);
    expect(audit.listByTenant('t2')).toHaveLength(0);
  });
});
