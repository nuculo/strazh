import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * грань №12 — the durable half of the "ask" adaptation: `admitDispatch()`'s doc
 * comment explains why this exists instead of an in-memory suspended `Promise`.
 * `resolve()` is the "claim before effect, resolve once" half of the original
 * idea — a conditional `UPDATE ... WHERE decision IS NULL` is what makes two racing
 * resolvers unable to both win, the same idempotent-write pattern `OutboxStore`
 * already uses.
 */
export type ApprovalDecision = 'APPROVED' | 'DENIED';

export interface PendingApproval {
  readonly approvalId: string;
  readonly runStepId: string;
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly operationFamily: string;
  readonly requestedAt: string;
  readonly decision: ApprovalDecision | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

export interface RequestApprovalInput {
  readonly runStepId: string;
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly operationFamily: string;
}

export type ResolveResult =
  | { readonly resolved: true; readonly approval: PendingApproval }
  | { readonly resolved: false; readonly reason: 'NOT_FOUND' }
  /** Someone already claimed this one — the exact race `resolve()`'s conditional UPDATE exists to prevent either side from winning silently. */
  | { readonly resolved: false; readonly reason: 'ALREADY_DECIDED'; readonly approval: PendingApproval };

export class PendingApprovalStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Idempotent by `runStepId` — a retried, still-pending dispatch gets back the same ask, never a second row. */
  requestApproval(input: RequestApprovalInput, now = new Date()): PendingApproval {
    const existing = this.get(input.runStepId);
    if (existing) return existing;

    const approvalId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pending_approvals (approval_id, run_step_id, campaign_id, assessment_run_id, operation_family, requested_at, decision, decided_by, decided_at)
         VALUES (@approvalId, @runStepId, @campaignId, @assessmentRunId, @operationFamily, @requestedAt, NULL, NULL, NULL)`,
      )
      .run({
        approvalId,
        runStepId: input.runStepId,
        campaignId: input.campaignId,
        assessmentRunId: input.assessmentRunId,
        operationFamily: input.operationFamily,
        requestedAt: now.toISOString(),
      });

    const created = this.get(input.runStepId);
    if (!created) throw new Error(`PendingApproval for RunStep ${input.runStepId} vanished immediately after insert`);
    return created;
  }

  get(runStepId: string): PendingApproval | null {
    const row = this.db.prepare(`SELECT * FROM pending_approvals WHERE run_step_id = @runStepId`).get({ runStepId }) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  getById(approvalId: string): PendingApproval | null {
    const row = this.db.prepare(`SELECT * FROM pending_approvals WHERE approval_id = @approvalId`).get({ approvalId }) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  listPending(): PendingApproval[] {
    const rows = this.db.prepare(`SELECT * FROM pending_approvals WHERE decision IS NULL ORDER BY requested_at ASC`).all() as unknown as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  /**
   * Claims exactly once. The `WHERE decision IS NULL` guard is the whole mechanism:
   * a second `resolve()` call for the same `approvalId` — whether a genuine race or
   * an operator re-running a command — always sees `changes: 0` and is told
   * `ALREADY_DECIDED` with the decision that actually won, never silently overwrites
   * it or reports success for an effect that didn't happen.
   */
  resolve(approvalId: string, decision: ApprovalDecision, decidedBy: string, now = new Date()): ResolveResult {
    const result = this.db
      .prepare(`UPDATE pending_approvals SET decision = @decision, decided_by = @decidedBy, decided_at = @decidedAt WHERE approval_id = @approvalId AND decision IS NULL`)
      .run({ approvalId, decision, decidedBy, decidedAt: now.toISOString() });

    if (Number(result.changes) === 0) {
      const existing = this.getById(approvalId);
      if (!existing) return { resolved: false, reason: 'NOT_FOUND' };
      return { resolved: false, reason: 'ALREADY_DECIDED', approval: existing };
    }

    const updated = this.getById(approvalId);
    if (!updated) throw new Error(`PendingApproval ${approvalId} vanished immediately after resolve()`);
    return { resolved: true, approval: updated };
  }
}

interface ApprovalRow {
  approval_id: string;
  run_step_id: string;
  campaign_id: string;
  assessment_run_id: string;
  operation_family: string;
  requested_at: string;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

function rowToApproval(row: ApprovalRow): PendingApproval {
  return {
    approvalId: row.approval_id,
    runStepId: row.run_step_id,
    campaignId: row.campaign_id,
    assessmentRunId: row.assessment_run_id,
    operationFamily: row.operation_family,
    requestedAt: row.requested_at,
    decision: row.decision as ApprovalDecision | null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}
