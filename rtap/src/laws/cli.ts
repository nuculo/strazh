#!/usr/bin/env node
import { buildRegistry } from './index.js';

const seedArg = process.argv.find((a) => a.startsWith('--seed='));
const seed = seedArg ? Number(seedArg.slice('--seed='.length)) : 1;

const registry = buildRegistry();
const report = await registry.runAll(seed);

const ICON = { held: '✓', failed: '✗', pending: '·' } as const;

console.log('Evidence: ✓/✗ = Observed (a property test actually ran) · · = Missing (pending, see reason) — README\'s "Evidence levels"');
console.log('');

for (const r of report.results) {
  if (r.status === 'pending') {
    console.log(`${ICON.pending} ${r.id}  (pending: ${r.pendingReason})`);
    continue;
  }
  const icon = r.held ? ICON.held : ICON.failed;
  console.log(`${icon} ${r.id}  (${r.trialsRun} trials, seed ${r.seed})`);
  if (!r.held) {
    for (const f of r.failures.slice(0, 3)) {
      console.log(`    trial ${f.trial} seed ${f.seed}: ${f.detail}`);
      console.log(`    counterexample: ${JSON.stringify(f.counterexample)}`);
    }
    if (r.failures.length > 3) {
      console.log(`    ... and ${r.failures.length - 3} more failing trial(s)`);
    }
  }
}

console.log('');
console.log(
  `${report.total} laws total — ${report.implemented} implemented (${report.held} held, ${report.failed} failed) — ${report.pending} pending`,
);
console.log(`run seed: ${seed} (pass --seed=N to replay with a different seed)`);

process.exit(report.failed > 0 ? 1 : 0);
