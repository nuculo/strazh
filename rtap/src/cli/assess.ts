#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../db/connection.js';
import { RunStepStore } from '../runsteps/store.js';
import { ExecutionAttemptStore } from '../execution/execution-attempt-store.js';
import { ObservationStore } from '../observations/store.js';
import { CampaignEventStore } from '../events/store.js';
import { ConcurrencyScheduler } from '../execution/concurrency-scheduler.js';
import { RoleBasedAuthorizationProvider } from '../authz/role-based-provider.js';
import { FilesystemArtifactStore } from '../artifacts/filesystem-store.js';
import { runPromptfooWorkerOnce, type PromptfooWorkerConfig, type PromptfooWorkerDeps } from '../worker/promptfoo-worker.js';
import { PromptfooCliAdapter } from '../adapters/promptfoo/run.js';
import type { SandboxProfile } from '../execution/sandbox.js';
import { correlateFindings, type ObservationLike } from '../pipeline/correlate.js';
import { buildJsonReport, buildMarkdownReport, buildAssessmentReport, type ReportInput } from '../pipeline/report.js';
import { buildSarifReport } from '../pipeline/sarif.js';
import { targetProbeKey } from '../features/history-view.js';
import { AssessmentRunStore } from '../planner/assessment-run-store.js';
import type { ArtifactRef } from '../artifacts/store.js';
import { loadTargetConfig, buildProbeConfig, TargetConfigError, type AssessProbe, type TargetConfig } from './target-config.js';

/**
 * M1 — `rtap assess <target.yaml>`: the smallest end-to-end product flow.
 *
 * Reuses the production execution path wholesale — `runPromptfooWorkerOnce()` (the
 * same drain loop `worker/cli.ts` uses), the real `PromptfooCliAdapter`, the real
 * stores, evidence materialization, verdict derivation, finding correlation, and the
 * existing JSON/Markdown/SARIF report builders. It adds only: target-file parsing,
 * per-probe promptfoo config generation, one-RunStep-per-probe scheduling, and
 * coverage bookkeeping (scheduled vs. resolved) so the report can honestly say
 * COMPLETE / INCOMPLETE rather than confuse "no findings" with "nothing ran".
 *
 * This is NOT a second execution pipeline: it composes the same functions, it does
 * not reimplement admission, dispatch, fencing, commit, or reporting.
 *
 * Packaging note: there is no published `rtap` binary yet. The documented invocation
 * for this checkout is:
 *
 *   npm run assess -- --target=<target.yaml> --out-dir=<dir> \
 *     --promptfoo-entry=<.../promptfoo/dist/src/main.js> [--ollama-base-url=http://localhost:11434]
 *
 * (see package.json "assess" script → tsx src/cli/assess.ts). Exit codes:
 *   0  assessment completed, coverage COMPLETE (with or without findings)
 *   2  assessment completed but coverage INCOMPLETE (a probe failed to resolve —
 *      e.g. target unavailable): NOT a clean "no findings" result
 *   1  execution error before/around the assessment (bad config, setup failure)
 */

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function requireFlag(name: string): string {
  const v = flag(name);
  if (!v) {
    console.error(`missing required --${name}=...`);
    process.exit(1);
  }
  return v;
}

export interface AssessOptions {
  readonly targetPath: string;
  readonly outDir: string;
  readonly promptfooEntry: string;
  readonly ollamaBaseUrl: string;
  readonly dbPath: string;
  readonly maxRequests: number;
  /** Bounded execution: max wall-clock ms per probe's promptfoo process (SIGKILL on expiry). */
  readonly perProbeTimeoutMs: number;
  /**
   * Test-only seam: inject a `PromptfooCliAdapter` (e.g. one with a fake exec/read)
   * so the full assess flow can be exercised hermetically, exactly like the worker's
   * own tests. Omitted in production — the real default adapter is used.
   */
  readonly adapter?: PromptfooCliAdapter | undefined;
  /** Optional cancellation signal for operator kill switch */
  readonly signal?: AbortSignal | undefined;
  /** Optional caller-supplied assessment run identifier */
  readonly assessmentRunId?: string | undefined;
}

export interface AssessResult {
  readonly assessmentRunId: string;
  readonly totalObservations: number;
  readonly totalFindings: number;
  readonly byVerdict: Record<string, number>;
  readonly vulnerabilities: number;
  readonly resistant: number;
  readonly unverified: number;
  readonly errors: number;
  readonly coverageStatus: 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  readonly scheduled: number;
  readonly resolved: number;
  readonly unresolvedProbeIds: readonly string[];
  readonly markdownPath: string;
  readonly sarifPath: string;
  readonly jsonPath: string;
  /** Exit code the CLI should use — see the doc comment's exit-code contract. */
  readonly exitCode: 0 | 2;
}

/**
 * Run one assessment end-to-end. Returns a structured result; throws on execution
 * errors (bad config etc.) so the CLI wrapper can distinguish those (exit 1) from a
 * completed-but-incomplete assessment (exit 2).
 */
export async function runAssessment(opts: AssessOptions): Promise<AssessResult> {
  const target = loadTargetConfig(opts.targetPath);

  // A fixed, small request budget: each probe issues a bounded number of model
  // requests. `intent` uses 1 generation-ish + 1 target + 1 grade; `secret-marker`
  // uses 1 target call. We cap the probe COUNT to keep the whole run bounded and
  // localhost-cheap, and surface the cap rather than silently truncating.
  const budgetedProbes = target.probes;
  if (budgetedProbes.length > opts.maxRequests) {
    throw new AssessError(
      `target declares ${budgetedProbes.length} probes but --max-requests=${opts.maxRequests}; ` +
        `raise the budget explicitly or reduce probes (M1 keeps runs small on purpose)`,
    );
  }

  mkdirSync(opts.outDir, { recursive: true });
  const configDir = mkdtempSync(path.join(tmpdir(), 'rtap-assess-cfg-'));
  const artifactsDir = path.join(opts.outDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const assessmentRunId = opts.assessmentRunId ?? `assess-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const campaignId = `assess-campaign-${target.targetId}`;

  const db = openDatabase(opts.dbPath);
  const runSteps = new RunStepStore(db);
  const attempts = new ExecutionAttemptStore(db, runSteps);
  const observations = new ObservationStore(db);
  const events = new CampaignEventStore(db);
  const scheduler = new ConcurrencyScheduler(db);
  const authProvider = new RoleBasedAuthorizationProvider();
  const artifacts = new FilesystemArtifactStore(artifactsDir);
  const runs = new AssessmentRunStore(db);

  runs.start(assessmentRunId, campaignId);

  const promptfooConfigDir = path.join(opts.outDir, '.promptfoo');
  mkdirSync(promptfooConfigDir, { recursive: true });
  const sandbox = buildSandbox(opts.ollamaBaseUrl, promptfooConfigDir);
  const deps: PromptfooWorkerDeps = {
    db, runSteps, attempts, observations, events, scheduler, authProvider, artifacts,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  };

  // Enqueue AND drain ONE probe at a time. `runPromptfooWorkerOnce` drains every
  // currently-leasable RunStep for the assessment run in one call, using the single
  // worker config it is given — so enqueuing all probes up front and then looping
  // would run every step with the FIRST probe's config. Interleaving enqueue→drain
  // keeps each drain scoped to exactly the one step just enqueued, which is also how
  // we honor the one-result-per-RunStep contract with a distinct promptfoo config and
  // output path per probe. It is still the real production drain loop, unmodified.
  const scheduledKeys = new Set<string>();
  const workerErrors: string[] = [];
  for (const probe of budgetedProbes) {
    if (opts.signal?.aborted) {
      db.close();
      throw new AssessCancelledError('Assessment cancelled by operator');
    }
    const probeId = probeIdFor(probe);
    const configPath = path.join(configDir, `${probe.id}.json`);
    const outputPath = path.join(configDir, `${probe.id}.output.json`);
    writeFileSync(configPath, JSON.stringify(buildProbeConfig(target, probe), null, 2));

    runSteps.enqueue(
      assessmentRunId,
      probe.id, // idempotency key
      { campaignId, targetId: target.targetId, probeId, configPath, outputPath },
      new Date(),
      { campaignId, targetId: target.targetId },
    );
    scheduledKeys.add(targetProbeKey(target.targetId, probeId));

    // intent probes use `redteam run` (generation + LLM-judge grading); secret-marker
    // probes are plain deterministic `eval` runs (a not-contains assertion, no judge).
    const subcommand = probe.kind === 'secret-marker' ? 'eval' : 'redteam-run';
    const config = buildWorkerConfig({ artifactsDir, configPath, outputPath, sandbox, engineVersion: '0.122.0', promptfooEntry: opts.promptfooEntry, subcommand, timeoutMs: opts.perProbeTimeoutMs });
    const results = await runPromptfooWorkerOnce(deps, config, assessmentRunId, `assess-worker-${probe.id}`, 600_000);
    for (const r of results) {
      if (r.outcome.outcome !== 'COMMITTED') {
        workerErrors.push(`${r.runStepId}: ${r.outcome.outcome}${'detail' in r.outcome ? ` — ${r.outcome.detail}` : ''}`);
      }
    }
  }

  // Coverage: a probe is RESOLVED iff it produced a committed Observation whose
  // verdict is not ERROR. An ERROR verdict means the target could not actually be
  // tested (transport/provider failure — e.g. an unavailable endpoint), so the probe
  // did NOT resolve as an assessment. Counting ERROR as unresolved is what makes an
  // unavailable target surface as INCOMPLETE (exit 2), never a clean "no findings".
  // Anything with no committed observation at all (adapter crash, fenced) is also
  // unresolved. VULNERABLE / RESISTANT / UNVERIFIED all count as resolved.
  const records = observations.listByAssessmentRun(assessmentRunId);
  const resolvedKeys = new Set(records.filter((r) => r.verdict !== 'ERROR').map((r) => targetProbeKey(r.targetId, r.probeId)));
  const unresolved = [...scheduledKeys].filter((k) => !resolvedKeys.has(k));
  const unresolvedProbeIds = unresolved.map((k) => {
    const [, probeId] = JSON.parse(k) as [string, string];
    return probeId;
  });

  const obsLike: ObservationLike[] = records.map((r) => {
    const evidenceRefs = parseEvidenceRefs(r.evidenceRefs);
    return { id: r.id, targetId: r.targetId, probeId: r.probeId, verdict: r.verdict, ...(evidenceRefs ? { evidenceRefs } : {}) };
  });
  const findings = correlateFindings(obsLike);

  const input: ReportInput = {
    assessmentRunId,
    generatedAt: new Date().toISOString(),
    observations: obsLike,
    findings,
    coverage: { scheduled: scheduledKeys.size, unresolved },
  };

  const json = buildJsonReport(input);
  const markdown = buildMarkdownReport(input);
  const sarif = JSON.stringify(buildSarifReport(input, { toolVersion: '0.0.0-m1' }), null, 2);

  // Public reports directory: kept separate from private artifacts/evidence
  const reportsDir = path.join(opts.outDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path.join(reportsDir, 'report.md'), markdown);
  writeFileSync(path.join(reportsDir, 'report.sarif'), sarif);
  writeFileSync(path.join(reportsDir, 'report.json'), JSON.stringify(json, null, 2));

  // Legacy root paths preserved for backwards compatibility
  const markdownPath = path.join(opts.outDir, 'report.md');
  const sarifPath = path.join(opts.outDir, 'report.sarif');
  const jsonPath = path.join(opts.outDir, 'report.json');
  writeFileSync(markdownPath, markdown);
  writeFileSync(sarifPath, sarif);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  const gate = buildAssessmentReport(input);
  db.close();

  const result: AssessResult = {
    assessmentRunId,
    totalObservations: json.summary.totalObservations,
    totalFindings: json.summary.totalFindings,
    byVerdict: json.summary.byVerdict,
    vulnerabilities: json.summary.vulnerabilities,
    resistant: json.summary.resistant,
    unverified: json.summary.unverified,
    errors: json.summary.errors,
    coverageStatus: json.coverage.status,
    scheduled: json.coverage.scheduled ?? scheduledKeys.size,
    resolved: json.coverage.resolved ?? resolvedKeys.size,
    unresolvedProbeIds,
    markdownPath,
    sarifPath,
    jsonPath,
    exitCode: gate.ok ? 0 : 2,
  };

  if (workerErrors.length > 0) {
    console.error(`[assess] ${workerErrors.length} probe(s) did not commit an observation:`);
    for (const e of workerErrors) console.error(`  - ${e}`);
  }
  return result;
}

export class AssessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessError';
  }
}

export class AssessCancelledError extends Error {
  constructor(message = 'Assessment cancelled by operator') {
    super(message);
    this.name = 'AssessCancelledError';
  }
}

function probeIdFor(probe: AssessProbe): string {
  // RTAP's OWN probe identity — distinct per configured probe by construction
  // (`<kind>:<probe.id>`, and probe.id is validated unique in loadTargetConfig). This
  // is threaded to the worker via RunStepPayload.probeId and becomes the committed
  // Observation's probeId (parse.ts, ParseContext.probeId), so it stays stable and
  // distinct through scheduling → observation → coverage → report, regardless of the
  // native promptfoo metadata (which the intent plugin fixes at `intent:default` for
  // every intent probe). The native id is preserved separately in provenance.nativeProbeId.
  return `${probe.kind}:${probe.id}`;
}

function parseEvidenceRefs(raw: unknown): readonly ArtifactRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs: ArtifactRef[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as ArtifactRef).ref === 'string' && typeof (item as ArtifactRef).kind === 'string') {
      refs.push({ ref: (item as ArtifactRef).ref, kind: (item as ArtifactRef).kind });
    }
  }
  return refs;
}

function buildSandbox(ollamaBaseUrl: string, promptfooConfigDir?: string): SandboxProfile {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    OLLAMA_BASE_URL: ollamaBaseUrl,
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
    PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
    PROMPTFOO_DISABLE_SHARING: 'true',
    PROMPTFOO_CACHE_ENABLED: 'false',
    NEBIUS_API_KEY: process.env.NEBIUS_API_KEY || 'simulated-offline-dummy-key',
  };
  if (promptfooConfigDir) {
    env.PROMPTFOO_CONFIG_DIR = promptfooConfigDir;
  }
  if (process.env.HOME) {
    env.HOME = process.env.HOME;
  }
  if (process.env.TMPDIR) {
    env.TMPDIR = process.env.TMPDIR;
  }
  if (process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (process.env.NEBIUS_BASE_URL) {
    env.NEBIUS_BASE_URL = process.env.NEBIUS_BASE_URL;
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) env.APPDATA = process.env.APPDATA;
    if (process.env.LOCALAPPDATA) env.LOCALAPPDATA = process.env.LOCALAPPDATA;
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.TMP) env.TMP = process.env.TMP;
  }
  return { env };
}

function buildWorkerConfig(args: {
  artifactsDir: string;
  configPath: string;
  outputPath: string;
  sandbox: SandboxProfile;
  engineVersion: string;
  promptfooEntry: string;
  subcommand: 'redteam-run' | 'eval';
  timeoutMs: number;
}): PromptfooWorkerConfig {
  return {
    subjectId: 'assess-operator',
    tenantId: 'tenant-local',
    roles: ['OPERATOR'],
    policyRevision: 'assess-m1',
    capabilityDigest: 'assess-m1-capability',
    sandboxProfileRef: 'assess-sandbox',
    egressPolicyRef: 'assess-egress-localhost-only',
    receiptDurationMs: 600_000,
    adapterVersion: '0.1.0',
    engineVersion: args.engineVersion,
    concurrencyClass: 'TARGET_SERIAL',
    artifactsDir: args.artifactsDir,
    promptfoo: {
      configPath: args.configPath,
      outputPath: args.outputPath,
      binPath: args.promptfooEntry,
      subcommand: args.subcommand,
      timeoutMs: args.timeoutMs,
    },
    sandbox: args.sandbox,
  };
}

async function main(): Promise<void> {
  const targetPath = requireFlag('target');
  const outDir = flag('out-dir') ?? flag('out') ?? path.join(process.cwd(), 'assess-out');

  let promptfooEntry = flag('promptfoo-entry') ?? process.env.PROMPTFOO_ENTRY;
  if (!promptfooEntry) {
    const candidates = [
      path.resolve(process.cwd(), '../../_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js'),
      path.resolve(process.cwd(), 'm0/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js'),
      path.resolve(process.cwd(), '../promptfoo/dist/src/main.js'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        promptfooEntry = c;
        break;
      }
    }
  }
  if (!promptfooEntry) {
    console.error('missing required --promptfoo-entry=... (and no candidate found in _tooling, m0/promptfoo-runtime, or ../promptfoo)');
    process.exit(1);
  }

  const ollamaBaseUrl = flag('ollama-base-url') ?? 'http://localhost:11434';
  const dbPath = flag('db') ?? path.join(outDir, 'assessment.sqlite');
  const maxRequests = Number.parseInt(flag('max-requests') ?? '8', 10);
  // Bounded execution: default 5 min per probe; a hung engine is SIGKILLed and the
  // probe becomes a clean failure (INCOMPLETE), never an unbounded hang.
  const perProbeTimeoutMs = Number.parseInt(flag('timeout-ms') ?? '300000', 10);

  try {
    const r = await runAssessment({ targetPath, outDir, promptfooEntry, ollamaBaseUrl, dbPath, maxRequests, perProbeTimeoutMs });
    console.log('===== RTAP assess =====');
    console.log(`assessment run:      ${r.assessmentRunId}`);
    console.log(`coverage:            ${r.coverageStatus} (${r.resolved}/${r.scheduled} probes resolved)`);
    if (r.unresolvedProbeIds.length > 0) console.log(`unresolved probes:   ${r.unresolvedProbeIds.join(', ')}`);
    console.log(`evaluated results:   ${r.totalObservations} observation(s), ${r.totalFindings} result group(s)`);
    console.log(`vulnerabilities:     ${r.vulnerabilities}`);
    console.log(`resistant:           ${r.resistant}`);
    console.log(`unverified:          ${r.unverified}`);
    console.log(`errors:              ${r.errors}`);
    console.log(`markdown report:     ${r.markdownPath}`);
    console.log(`sarif report:        ${r.sarifPath}`);
    console.log(`json report:         ${r.jsonPath}`);
    if (r.exitCode === 2) {
      console.log('\nstatus: INCOMPLETE — at least one scheduled probe did not resolve; this is NOT a clean "no findings" result.');
    } else if (r.vulnerabilities > 0) {
      console.log(`\nstatus: COMPLETE — ${r.vulnerabilities} vulnerability(ies) found.`);
    } else {
      console.log('\nstatus: COMPLETE — no vulnerabilities found.');
    }
    process.exit(r.exitCode);
  } catch (err) {
    if (err instanceof TargetConfigError || err instanceof AssessError) {
      console.error(`[assess] configuration/execution error: ${err.message}`);
      process.exit(1);
    }
    console.error('[assess] unexpected error:', err);
    process.exit(1);
  }
}

// Only run main() when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('cli', 'assess.ts'))) {
  void main();
}
