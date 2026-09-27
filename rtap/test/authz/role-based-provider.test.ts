import { describe, expect, it } from 'vitest';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import type { Principal } from '../../src/authz/types.js';

describe('RoleBasedAuthorizationProvider', () => {
  const provider = new RoleBasedAuthorizationProvider();

  it('allows a VIEWER to read within their own tenant', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['VIEWER'] };
    const result = provider.authorize({ principal, action: 'campaign:read', resourceTenantId: 'tenant-a' });
    expect(result.allowed).toBe(true);
  });

  it('denies a VIEWER from dispatching a run step', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['VIEWER'] };
    const result = provider.authorize({ principal, action: 'run-step:dispatch', resourceTenantId: 'tenant-a' });
    expect(result.allowed).toBe(false);
  });

  it('allows an OPERATOR to dispatch a run step and resolve secrets, but not promote a model', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['OPERATOR'] };
    expect(provider.authorize({ principal, action: 'run-step:dispatch', resourceTenantId: 'tenant-a' }).allowed).toBe(true);
    expect(provider.authorize({ principal, action: 'secret:resolve', resourceTenantId: 'tenant-a' }).allowed).toBe(true);
    expect(provider.authorize({ principal, action: 'model:promote', resourceTenantId: 'tenant-a' }).allowed).toBe(false);
  });

  it('allows an ADMIN to promote a model and swap a domain adapter', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['ADMIN'] };
    expect(provider.authorize({ principal, action: 'model:promote', resourceTenantId: 'tenant-a' }).allowed).toBe(true);
    expect(provider.authorize({ principal, action: 'domain-adapter:swap', resourceTenantId: 'tenant-a' }).allowed).toBe(true);
  });

  it('denies an ADMIN from acting on another tenant\'s resource', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['ADMIN'] };
    const result = provider.authorize({ principal, action: 'model:promote', resourceTenantId: 'tenant-b' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('tenant');
  });

  it('grants a permission from any one of multiple held roles', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['VIEWER', 'OPERATOR'] };
    expect(provider.authorize({ principal, action: 'run-step:dispatch', resourceTenantId: 'tenant-a' }).allowed).toBe(true);
  });

  it('denies a principal with no roles', () => {
    const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: [] };
    expect(provider.authorize({ principal, action: 'campaign:read', resourceTenantId: 'tenant-a' }).allowed).toBe(false);
  });
});
