#!/usr/bin/env node
import { openDatabase } from '../db/connection.js';
import { PendingApprovalStore, type ApprovalDecision } from '../execution/approval-store.js';

/**
 * грань №12's resolver — the "who resolves it and how" half of the design. A CLI
 * command, matching this repo's existing `laws`/`worker` pattern, not a new HTTP
 * server or webhook this repo has no other reason to run.
 *
 *   tsx src/approval/cli.ts list --db=...
 *   tsx src/approval/cli.ts resolve --db=... --approval-id=... --decision=APPROVED --decided-by=operator-name
 *
 * `resolve` is the "claim before effect, resolve once" half of the original idea —
 * `PendingApprovalStore.resolve()`'s own `WHERE decision IS NULL` guard is what makes
 * two racing operators (or the same operator running the command twice) unable to
 * both win; this CLI just reports whichever outcome actually happened.
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function requireFlag(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`missing required --${name}=...`);
    process.exit(1);
  }
  return value;
}

const command = process.argv[2];
const dbPath = requireFlag('db');
const db = openDatabase(dbPath);
const approvals = new PendingApprovalStore(db);

if (command === 'list') {
  const pending = approvals.listPending();
  if (pending.length === 0) {
    console.log('No pending approvals.');
  } else {
    for (const p of pending) {
      console.log(`${p.approvalId}  runStep=${p.runStepId}  campaign=${p.campaignId}  operationFamily=${p.operationFamily}  requestedAt=${p.requestedAt}`);
    }
  }
  process.exit(0);
} else if (command === 'resolve') {
  const approvalId = requireFlag('approval-id');
  const decisionRaw = requireFlag('decision');
  const decidedBy = requireFlag('decided-by');
  if (decisionRaw !== 'APPROVED' && decisionRaw !== 'DENIED') {
    console.error(`--decision must be APPROVED or DENIED, got "${decisionRaw}"`);
    process.exit(1);
  }
  const decision = decisionRaw as ApprovalDecision;

  const result = approvals.resolve(approvalId, decision, decidedBy);
  if (result.resolved) {
    console.log(`${approvalId}: ${decision} by ${decidedBy}`);
    process.exit(0);
  }
  if (result.reason === 'NOT_FOUND') {
    console.error(`${approvalId}: no such pending approval`);
    process.exit(1);
  }
  console.error(`${approvalId}: already resolved as ${result.approval.decision} by ${result.approval.decidedBy} at ${result.approval.decidedAt} — this resolve did not win the race`);
  process.exit(1);
} else {
  console.error(`usage: tsx src/approval/cli.ts <list|resolve> --db=... [--approval-id=... --decision=APPROVED|DENIED --decided-by=...]`);
  process.exit(1);
}
