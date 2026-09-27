import type { DatabaseSync } from 'node:sqlite';

export interface AuditEntry {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly action: string;
  readonly resourceTenantId: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly at: string;
}

/**
 * SQLite-backed, append-only. Phase 7's "audit" bullet: a decision recorded here is
 * never updated or deleted by anything in this package — `record()` is the only
 * write path, and it is always an insert.
 */
export class AuditLog {
  constructor(private readonly db: DatabaseSync) {}

  record(entry: Omit<AuditEntry, 'at'>, now = new Date()): AuditEntry {
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO audit_log (tenant_id, subject_id, action, resource_tenant_id, allowed, reason, at)
         VALUES (@tenantId, @subjectId, @action, @resourceTenantId, @allowed, @reason, @at)`,
      )
      .run({
        tenantId: entry.tenantId,
        subjectId: entry.subjectId,
        action: entry.action,
        resourceTenantId: entry.resourceTenantId,
        allowed: entry.allowed ? 1 : 0,
        reason: entry.reason,
        at,
      });
    return { ...entry, at };
  }

  listByTenant(tenantId: string): AuditEntry[] {
    const rows = this.db.prepare(`SELECT * FROM audit_log WHERE tenant_id = @tenantId ORDER BY at ASC, id ASC`).all({ tenantId }) as unknown as {
      tenant_id: string;
      subject_id: string;
      action: string;
      resource_tenant_id: string;
      allowed: number;
      reason: string;
      at: string;
    }[];
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      subjectId: r.subject_id,
      action: r.action,
      resourceTenantId: r.resource_tenant_id,
      allowed: r.allowed === 1,
      reason: r.reason,
      at: r.at,
    }));
  }
}
