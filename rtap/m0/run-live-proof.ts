/**
 * M0 LIVE PROOF harness — NOT production code, NOT part of the RTAP build/test.
 *
 * Proves the single gap the audit identified: that RTAP's *real* production
 * promptfoo path can drive a *live* promptfoo process against a *local* model and
 * commit a *real* Observation — with no fixture and no injected fake anywhere.
 *
 * It deliberately reuses the production composition verbatim:
 *   - real store constructors (openDatabase -> migrations, RunStepStore, ...)
 *   - the real `runPromptfooWorkerOnce()` drain loop (src/worker/promptfoo-worker.ts)
 *   - the DEFAULT `PromptfooCliAdapter` (real execFile, real readFile) — no execFn
 *     override, no readFileFn override.
 *
 * The ONLY things this harness supplies that a test cannot are real-world inputs:
 * a real promptfoo binary path, a real local model, and a real config. Everything
 * downstream of `adapter.run()` is the exact same code the repo already ships and
 * tests hermetically.
 *
 * Usage (PowerShell), from rtap/:
 *   $env:M0_PROMPTFOO_BIN = "<repo>/_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js"
 *   $env:M0_DB = "<abs path>/m0-proof.sqlite"
 *   npx tsx m0/run-live-proof.ts
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/connection.js';
import { RunStepStore } from '../src/runsteps/store.js';
import { ExecutionAttemptStore } from '../src/execution/execution-attempt-store.js';
import { ObservationStore } from '../src/observations/store.js';
import { CampaignEventStore } from '../src/events/store.js';
import { ConcurrencyScheduler } from '../src/execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../src/authz/role-based-provider.js';
import { FilesystemArtifactStore } from '../src/artifacts/filesystem-store.js';
import { PromptfooCliAdapter } from '../src/adapters/promptfoo/run.js';
import { runPromptfooWorkerOnce, type PromptfooWorkerConfig, type PromptfooWorkerDeps } from '../src/worker/promptfoo-worker.js';
import type { SandboxProfile } from '../src/execution/sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  // --- Real-world inputs the harness must be told about --------------------
  const promptfooBin = requireEnv('M0_PROMPTFOO_BIN'); // absolute path to promptfoo's dist/src/main.js
  const dbPath = requireEnv('M0_DB'); // where to persist — a real file, not :memory:, so we can inspect it read-only after
  const configPath = process.env.M0_CONFIG ?? path.join(here, 'redteam.local.yaml');
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

  if (!existsSync(promptfooBin)) throw new Error(`promptfoo entrypoint not found: ${promptfooBin}`);
  if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);

  const outputPath = path.join(here, 'promptfoo-output.json'); // deterministic output path
  const artifactsRoot = mkdtempSync(path.join(tmpdir(), 'rtap-m0-artifacts-'));

  // --- Real RTAP stores (same constructors production uses) ----------------
  const db = openDatabase(dbPath);
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const artifacts = new FilesystemArtifactStore(artifactsRoot);

  // The DEFAULT adapter — real execFile + real readFile. No fakes.
  const adapter = new PromptfooCliAdapter();

  const assessmentRunId = `m0-run-${Date.now()}`;
  const campaignId = 'm0-campaign';
  const targetId = 'ollama-qwen2.5-0.5b-local';

  // Enqueue exactly one RunStep, with identity (campaignId/targetId) as the
  // production worker requires.
  const { step } = runSteps.enqueue(
    assessmentRunId,
    'probe-0',
    { campaignId, targetId, probeId: 'intent:default' },
    new Date(),
    { campaignId, targetId },
  );
  console.log(`[m0] enqueued RunStep ${step.id}`);

  // The privilege/env scope handed to the real execFile() call. Carries ONLY
  // what promptfoo needs: PATH (to find node/ollama), the Ollama base URL, and
  // telemetry/update/remote-generation kill switches — never this process's full
  // environment.
  const sandbox: SandboxProfile = {
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '', // node on Windows needs this to spawn
      OLLAMA_BASE_URL: ollamaBaseUrl,
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true', // force 100% local generation
      PROMPTFOO_DISABLE_SHARING: 'true',
    },
  };

  const config: PromptfooWorkerConfig = {
    subjectId: 'm0-operator',
    tenantId: 'tenant-local',
    roles: ['OPERATOR'],
    policyRevision: 'm0-policy',
    capabilityDigest: 'm0-capability-digest',
    sandboxProfileRef: 'm0-sandbox',
    egressPolicyRef: 'm0-egress-localhost-only',
    receiptDurationMs: 600_000,
    adapterVersion: '0.1.0',
    engineVersion: '0.122.0',
    concurrencyClass: 'TARGET_SERIAL',
    artifactsDir: artifactsRoot,
    promptfoo: {
      configPath,
      outputPath,
      // M0_PROMPTFOO_BIN points at promptfoo's JavaScript ENTRYPOINT
      // (`.../node_modules/promptfoo/dist/src/main.js`), not the npm `.cmd`/POSIX
      // shim. defaultExec() (adapters/promptfoo/run.ts) spawns the current Node
      // executable with that entrypoint as its own argv element — shell-free and
      // cross-platform, so spaces in the path are inert.
      binPath: promptfooBin,
      cwd: here,
    },
    sandbox,
  };

  const deps: PromptfooWorkerDeps = {
    db,
    runSteps,
    attempts,
    observations,
    events,
    scheduler,
    authProvider,
    artifacts,
    adapter,
  };

  console.log(`[m0] running production worker runPromptfooWorkerOnce() against live promptfoo...`);
  const results = await runPromptfooWorkerOnce(deps, config, assessmentRunId, 'm0-worker', 600_000);

  // --- Report every ID the milestone asks for -----------------------------
  console.log('\n===== M0 RESULT =====');
  console.log(JSON.stringify({ assessmentRunId, campaignId, targetId, results }, null, 2));

  if (existsSync(outputPath)) {
    const raw = readFileSync(outputPath, 'utf-8');
    let count = -1;
    try {
      count = (JSON.parse(raw) as { results?: unknown[] }).results?.length ?? -1;
    } catch {
      /* leave -1 */
    }
    console.log(`[m0] promptfoo output file: ${outputPath} (results: ${count})`);
  } else {
    console.log(`[m0] WARNING: no promptfoo output file at ${outputPath}`);
  }

  const stored = observations.listByAssessmentRun(assessmentRunId);
  console.log(`[m0] Observations committed for ${assessmentRunId}: ${stored.length}`);
  for (const o of stored) {
    console.log(`  - Observation ${o.id} verdict=${o.verdict} probeId=${o.probeId}`);
    const refs = (o as unknown as { evidenceRefs?: { ref: string; kind: string }[] }).evidenceRefs ?? [];
    for (const r of refs) console.log(`      evidence: ${r.kind} ${r.ref}`);
    const attemptId = (o as unknown as { executionAttemptId?: string | null }).executionAttemptId ?? null;
    console.log(`      executionAttemptId: ${attemptId}`);
  }

  const attemptRows = attempts.listByRunStep(step.id);
  for (const a of attemptRows) {
    console.log(`[m0] ExecutionAttempt ${a.executionAttemptId} terminalReason=${a.terminalReason} leaseGen=${a.leaseGeneration}`);
  }
  const finalStep = runSteps.get(step.id);
  console.log(`[m0] final RunStep status: ${finalStep?.status}`);

  db.close();
  // Leave the DB file for read-only inspection; clean up only the temp artifacts dir copy is NOT done —
  // artifacts live under tmp and are content-addressed; keep them so evidence refs resolve during inspection.
  console.log(`[m0] artifacts root (keep for inspection): ${artifactsRoot}`);
  void rmSync; // intentionally unused; artifacts kept for inspection
}

main().catch((err) => {
  console.error('[m0] FAILED:', err);
  process.exit(1);
});
