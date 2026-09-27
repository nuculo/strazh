import type { DatabaseSync } from 'node:sqlite';
import { validate } from '../schemas/index.js';
import type { Finding } from '../pipeline/correlate.js';

export class FindingStore {
  constructor(private readonly db: DatabaseSync) {}

  put(finding: Finding, now = new Date()): Finding {
    const check = validate('rtap:finding', finding);
    if (!check.valid) {
      throw new Error(`Refusing to store an invalid Finding: ${check.errors.join('; ')}`);
    }
    this.db
      .prepare(
        `INSERT INTO findings (id, target_id, verdict, severity, body_json, created_at)
         VALUES (@id, @targetId, @verdict, @severity, @bodyJson, @createdAt)`,
      )
      .run({
        id: finding.id,
        targetId: finding.targetId,
        verdict: finding.verdict,
        severity: finding.severity,
        bodyJson: JSON.stringify(finding),
        createdAt: now.toISOString(),
      });
    return finding;
  }

  listByTarget(targetId: string): Finding[] {
    const rows = this.db
      .prepare(`SELECT body_json FROM findings WHERE target_id = @targetId ORDER BY created_at ASC`)
      .all({ targetId }) as { body_json: string }[];
    return rows.map((r) => JSON.parse(r.body_json) as Finding);
  }
}
