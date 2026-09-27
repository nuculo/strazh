import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { PendingApprovalStore, type RequestApprovalInput } from '../../src/execution/approval-store.js';

function input(overrides: Partial<RequestApprovalInput> = {}): RequestApprovalInput {
  return {
    runStepId: 'step-1',
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    operationFamily: 'llm-attack',
    ...overrides,
  };
}

describe('PendingApprovalStore (грань №12 — the durable half of "ask")', () => {
  it('requestApproval() creates a new, undecided approval', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    const approval = store.requestApproval(input());
    expect(approval.runStepId).toBe('step-1');
    expect(approval.decision).toBeNull();
    expect(approval.decidedBy).toBeNull();
    expect(approval.decidedAt).toBeNull();
  });

  it('requestApproval() is idempotent by runStepId — a retried, still-pending dispatch gets back the same row, not a second one', () => {
    const db = openInMemoryDatabase();
    const store = new PendingApprovalStore(db);
    const first = store.requestApproval(input());
    const second = store.requestApproval(input());
    expect(second.approvalId).toBe(first.approvalId);

    const count = (db.prepare(`SELECT COUNT(*) as n FROM pending_approvals`).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('get() returns null for a RunStep with no ask, and the row once one exists', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    expect(store.get('step-1')).toBeNull();
    const approval = store.requestApproval(input());
    expect(store.get('step-1')).toEqual(approval);
  });

  it('listPending() returns only undecided approvals, oldest first', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    const now0 = new Date(0);
    const now1 = new Date(1000);
    const now2 = new Date(2000);
    store.requestApproval(input({ runStepId: 'step-1' }), now0);
    const second = store.requestApproval(input({ runStepId: 'step-2' }), now1);
    store.requestApproval(input({ runStepId: 'step-3' }), now2);
    store.resolve(second.approvalId, 'APPROVED', 'operator-1', now2);

    const pending = store.listPending();
    expect(pending.map((p) => p.runStepId)).toEqual(['step-1', 'step-3']);
  });

  it('resolve() claims exactly once — a second resolve() for the same approval reports ALREADY_DECIDED with the decision that actually won', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    const approval = store.requestApproval(input());

    const first = store.resolve(approval.approvalId, 'APPROVED', 'operator-1');
    expect(first.resolved).toBe(true);
    if (!first.resolved) return;
    expect(first.approval.decision).toBe('APPROVED');
    expect(first.approval.decidedBy).toBe('operator-1');

    // A second, racing resolver tries to deny the same approval after it was approved.
    const second = store.resolve(approval.approvalId, 'DENIED', 'operator-2');
    expect(second.resolved).toBe(false);
    if (second.resolved) return;
    expect(second.reason).toBe('ALREADY_DECIDED');
    if (second.reason !== 'ALREADY_DECIDED') return;
    expect(second.approval.decision).toBe('APPROVED'); // the first resolver's decision won, not silently overwritten
    expect(second.approval.decidedBy).toBe('operator-1');
  });

  it('resolve() on an approval that was never requested reports NOT_FOUND', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    const result = store.resolve('never-requested', 'APPROVED', 'operator-1');
    expect(result.resolved).toBe(false);
    if (result.resolved) return;
    expect(result.reason).toBe('NOT_FOUND');
  });

  it('a denied approval is also permanently claimed — cannot be re-resolved to APPROVED later', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    const approval = store.requestApproval(input());
    store.resolve(approval.approvalId, 'DENIED', 'operator-1');

    const retry = store.resolve(approval.approvalId, 'APPROVED', 'operator-2');
    expect(retry.resolved).toBe(false);
    if (retry.resolved) return;
    expect(retry.reason).toBe('ALREADY_DECIDED');
    if (retry.reason !== 'ALREADY_DECIDED') return;
    expect(retry.approval.decision).toBe('DENIED');
  });

  it('keeps different RunSteps as separate approvals', () => {
    const store = new PendingApprovalStore(openInMemoryDatabase());
    const a = store.requestApproval(input({ runStepId: 'step-a' }));
    const b = store.requestApproval(input({ runStepId: 'step-b' }));
    expect(a.approvalId).not.toBe(b.approvalId);
    expect(store.get('step-a')?.approvalId).toBe(a.approvalId);
    expect(store.get('step-b')?.approvalId).toBe(b.approvalId);
  });
});
