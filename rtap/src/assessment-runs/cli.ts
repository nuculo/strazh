#!/usr/bin/env node
import { openDatabase } from '../db/connection.js';
import { AssessmentRunStore } from '../planner/assessment-run-store.js';

/**
 * грань №20's operator surface — same shape as `approval/cli.ts`, in its own
 * top-level directory even though its store lives in `planner/` (next to its hot
 * caller `run-once.ts`) — matching that same split.
 *
 *   tsx src/assessment-runs/cli.ts start          --db=... --assessment-run-id=... --campaign-id=...
 *   tsx src/assessment-runs/cli.ts show            --db=... --assessment-run-id=...
 *   tsx src/assessment-runs/cli.ts list            --db=... [--campaign-id=...]
 *   tsx src/assessment-runs/cli.ts accept-coverage --db=... --assessment-run-id=... --note=... --accepted-by=...
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
const store = new AssessmentRunStore(db);

if (command === 'start') {
  const assessmentRunId = requireFlag('assessment-run-id');
  const campaignId = requireFlag('campaign-id');
  const record = store.start(assessmentRunId, campaignId);
  console.log(`${assessmentRunId}: started under campaign ${record.campaignId} at ${record.startedAt} (intelligence=${record.intelligenceStatus})`);
  process.exit(0);
} else if (command === 'show') {
  const assessmentRunId = requireFlag('assessment-run-id');
  const record = store.get(assessmentRunId);
  if (!record) {
    console.error(`${assessmentRunId}: no such AssessmentRun`);
    process.exit(1);
  }
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
} else if (command === 'list') {
  const campaignId = flag('campaign-id');
  const rows = store.listAll().filter((r) => !campaignId || r.campaignId === campaignId);
  if (rows.length === 0) {
    console.log('No assessment runs recorded.');
  } else {
    for (const r of rows) {
      console.log(`${r.assessmentRunId}  campaign=${r.campaignId}  intelligenceStatus=${r.intelligenceStatus}${r.everDegradedAt ? `  everDegraded=${r.everDegradedAt}` : ''}${r.acceptedAt ? '  ACCEPTED' : ''}`);
    }
  }
  process.exit(0);
} else if (command === 'accept-coverage') {
  const assessmentRunId = requireFlag('assessment-run-id');
  const note = requireFlag('note');
  const acceptedBy = requireFlag('accepted-by');
  const result = store.acceptCoverage(assessmentRunId, note, acceptedBy);
  if (result.accepted) {
    console.log(`${assessmentRunId}: coverage accepted by ${acceptedBy} at ${result.record.acceptedAt} — "${note}"`);
    process.exit(0);
  }
  if (result.reason === 'NOT_FOUND') {
    console.error(`${assessmentRunId}: no such AssessmentRun — call "start" first`);
    process.exit(1);
  }
  console.error(`${assessmentRunId}: already accepted by ${result.record.acceptedBy} at ${result.record.acceptedAt} — "${result.record.coverageAcceptance}" — this accept-coverage did not win the race`);
  process.exit(1);
} else {
  console.error(`usage: tsx src/assessment-runs/cli.ts <start|show|list|accept-coverage> --db=... [--assessment-run-id=... --campaign-id=... --note=... --accepted-by=...]`);
  process.exit(1);
}
