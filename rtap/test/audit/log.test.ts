import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { AuditLog } from '../../src/audit/log.js';

describe('AuditLog', () => {
  it('records and lists entries for a tenant, in insertion order', () => {
    const audit = new AuditLog(openInMemoryDatabase());
    audit.record({ tenantId: 't1', subjectId: 's1', action: 'campaign:read', resourceTenantId: 't1', allowed: true, reason: 'ok' });
    audit.record({ tenantId: 't1', subjectId: 's2', action: 'model:promote', resourceTenantId: 't1', allowed: false, reason: 'denied' });

    const entries = audit.listByTenant('t1');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ subjectId: 's1', allowed: true });
    expect(entries[1]).toMatchObject({ subjectId: 's2', allowed: false });
  });

  it('keeps tenants separate', () => {
    const audit = new AuditLog(openInMemoryDatabase());
    audit.record({ tenantId: 't1', subjectId: 's1', action: 'campaign:read', resourceTenantId: 't1', allowed: true, reason: 'ok' });
    audit.record({ tenantId: 't2', subjectId: 's1', action: 'campaign:read', resourceTenantId: 't2', allowed: true, reason: 'ok' });

    expect(audit.listByTenant('t1')).toHaveLength(1);
    expect(audit.listByTenant('t2')).toHaveLength(1);
  });

  it('returns an empty list for a tenant with no entries', () => {
    const audit = new AuditLog(openInMemoryDatabase());
    expect(audit.listByTenant('never-touched')).toEqual([]);
  });
});
