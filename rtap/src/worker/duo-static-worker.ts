import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthorizationProvider, Principal, Role } from '../authz/types.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { materializeEvidence } from '../artifacts/materialize.js';
import type { CampaignEventStore } from '../events/store.js';
import type { ObservationStore } from '../observations/store.js';
import type { RunStepStore } from '../runsteps/store.js';
import type { RunStep, RunStepPayload } from '../runsteps/types.js';
import type { ExecutionAttemptStore } from '../execution/execution-attempt-store.js';
import type { ConcurrencyScheduler } from '../execution/concurrency-scheduler.js';
import type { ConcurrencyClass } from '../execution/types.js';
import type { DispatchGuardRequest } from '../execution/dispatch.js';
import { executeLeasedStep, leaseWithConcurrencyPrecheck, type StepResult, type StepRunner } from '../execution/run-step-executor.js';
import type { ObservationEventPair } from '../pipeline/commit-fenced-observation.js';
import { DuoStaticCliAdapter, type DuoStaticRunOptions } from '../adapters/duo-static/run.js';
import type { SandboxProfile } from '../execution/sandbox.js';
import { parseDuoStaticScan, type ParseContext } from '../adapters/duo-static/parse.js';
import { materializeDuoStaticEvidence } from '../adapters/duo-static/evidence.js';
import { eventForObservation } from '../pipeline/observation-event.js';

/**
 * грань №17: the same `admission -> dispatch -> fenced commit -> settlement`
 * composition `promptfoo-worker.ts` established, for duo-static — see that
 * file's doc comment for the mechanism this reuses unmodified
 * (`executeLeasedStep()`). What's genuinely different here, not copy-pasted:
 * one duo-static scan yields zero-to-many findings from a single invocation
 * (unlike promptfoo's one-invocation-one-result assumption), so
 * `buildDuoStaticStepRunner()` returns `StepOutcome.observations` as an array —
 * see `commitFencedObservations()` (`pipeline/commit-fenced-observation.ts`),
 * the primitive that makes committing all of them under one execution attempt
 * correct rather than a loop of `commitFencedObservation()` calls (which would
 * fail from the second finding on).
 */
export interface DuoStaticWorkerConfig {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly policyRevision: string;
  /** Same single-process caveat as `PromptfooWorkerConfig.capabilityDigest` — see that doc comment. */
  readonly capabilityDigest: string;
  readonly sandboxProfileRef: string;
  readonly egressPolicyRef: string;
  readonly receiptDurationMs: number;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly concurrencyClass: ConcurrencyClass;
  readonly artifactsDir: string;
  readonly duoStatic: Pick<DuoStaticRunOptions, 'path' | 'outputPath' | 'minSeverity' | 'binPath' | 'cwd'>;
  /** грань №15 scoping — same optional-with-safe-default as `PromptfooWorkerConfig.sandbox`. */
  readonly sandbox?: SandboxProfile;
}

export interface DuoStaticWorkerDeps {
  readonly db: DatabaseSync;
  readonly runSteps: RunStepStore;
  readonly attempts: ExecutionAttemptStore;
  readonly observations: ObservationStore;
  readonly events: CampaignEventStore;
  readonly scheduler: ConcurrencyScheduler;
  readonly authProvider: AuthorizationProvider;
  readonly artifacts: ArtifactStore;
  /** Injectable for tests. Defaults to a real `DuoStaticCliAdapter` — real `execFile`/`readFile`. */
  readonly adapter?: DuoStaticCliAdapter;
}

export interface MalformedStepOutcome {
  readonly outcome: 'MALFORMED_STEP';
  readonly detail: string;
}

export interface WorkerStepResult {
  readonly runStepId: string;
  readonly outcome: StepResult | MalformedStepOutcome;
}

function principalOf(config: DuoStaticWorkerConfig): Principal {
  return { subjectId: config.subjectId, tenantId: config.tenantId, roles: config.roles };
}

/**
 * Mirrors `promptfoo-worker.ts`'s `buildDispatchRequest()` field-for-field, with
 * the two differences that are actually about the engine: `operationFamily`
 * (`'static-scan'`, not `'llm-attack'`) and `destructive: false` — a duo-static
 * scan reads a repository path, it never sends traffic at a live target, so it
 * can share a `READ_ONLY_PARALLEL`-class concurrency slot rather than the serial
 * class a destructive engine needs. `concurrencyClass` itself stays
 * deployment-configured, same as promptfoo's, not hardcoded here.
 */
export function buildDispatchRequest(step: RunStep<RunStepPayload>, campaignId: string, targetId: string, config: DuoStaticWorkerConfig): DispatchGuardRequest {
  return {
    authorization: {
      principal: principalOf(config),
      resourceTenantId: config.tenantId,
      campaignId,
      assessmentRunId: step.assessmentRunId,
      runStepId: step.id,
      operationFamily: 'static-scan',
      targetSnapshotRef: targetId,
      adapterIdentity: { engineAdapterId: 'duo-static', engineAdapterVersion: config.adapterVersion },
      declaredCapabilityDigest: config.capabilityDigest,
      expectedCapabilityDigest: config.capabilityDigest,
      policyRevision: config.policyRevision,
      sandboxProfileRef: config.sandboxProfileRef,
      egressPolicyRef: config.egressPolicyRef,
      receiptDurationMs: config.receiptDurationMs,
    },
    concurrency: [
      {
        concurrencyClass: config.concurrencyClass,
        resourceKeys: [targetId],
        maxInFlight: null,
        supportsCancellation: false,
        destructive: false,
        rateLimitScope: null,
      },
    ],
    attemptStart: {
      assessmentRunId: step.assessmentRunId,
      runStepId: step.id,
      engineAdapterId: 'duo-static',
      engineAdapterVersion: config.adapterVersion,
      engineRequestId: randomUUID(),
    },
  };
}

export interface DuoStaticStepContext {
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly targetId: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
}

/**
 * One `duo-agents scan` invocation answers exactly one `RunStep` — "scan this
 * path" is the dispatched unit of work, the same way "run this probe" is for
 * promptfoo — but unlike promptfoo it naturally yields zero-to-many findings,
 * not exactly one result. A clean scan (`scan.findings.length === 0`) is a real,
 * successful attempt with nothing to report, not `NORMALIZATION_FAILED`: the
 * scan itself is still materialized as `native-report` evidence directly (there
 * is no per-finding `ParsedObservation` to route it through when there are no
 * findings), and `observations: []` flows into `commitFencedObservations()`,
 * which binds and terminalizes the attempt with nothing to insert.
 */
export function buildDuoStaticStepRunner(
  artifacts: ArtifactStore,
  runOptions: DuoStaticRunOptions,
  ctx: DuoStaticStepContext,
  now: () => Date = () => new Date(),
  adapter: DuoStaticCliAdapter = new DuoStaticCliAdapter(),
): StepRunner {
  return async () => {
    const runResult = await adapter.run(runOptions);
    if (!runResult.ok) {
      return { ok: false, terminalReason: 'FAILED_BEFORE_EFFECT', detail: runResult.error };
    }

    const { scan } = runResult;

    if (scan.findings.length === 0) {
      const [nativeRef] = await materializeEvidence(artifacts, ctx.assessmentRunId, [{ kind: 'native-report', body: JSON.stringify(scan) }]);
      return { ok: true, nativeResultRef: nativeRef!.ref, observations: [] };
    }

    const parseCtx: ParseContext = {
      assessmentRunId: ctx.assessmentRunId,
      targetId: ctx.targetId,
      engineVersion: ctx.engineVersion,
      adapterVersion: ctx.adapterVersion,
    };
    const parsedObservations = parseDuoStaticScan(scan, parseCtx);
    const occurredAt = now().toISOString();

    let nativeResultRef: string | undefined;
    const observations: ObservationEventPair[] = [];
    for (let i = 0; i < parsedObservations.length; i += 1) {
      const parsed = parsedObservations[i]!;
      const finding = scan.findings[i]!;
      const withEvidence = await materializeDuoStaticEvidence(artifacts, parsed, finding, scan);
      // scan -> native-report is content-addressed and identical on every
      // iteration (materializeDuoStaticEvidence()'s own doc comment) — grabbing
      // it once, off the first finding, is not an arbitrary choice.
      if (nativeResultRef === undefined) {
        nativeResultRef = withEvidence.evidenceRefs.find((r) => r.kind === 'native-report')?.ref;
      }
      observations.push({
        observation: withEvidence as never,
        event: eventForObservation(withEvidence as never, { campaignId: ctx.campaignId, assessmentRunId: ctx.assessmentRunId, occurredAt }),
      });
    }

    if (!nativeResultRef) {
      return { ok: false, terminalReason: 'NORMALIZATION_FAILED', detail: 'materializeDuoStaticEvidence() did not produce a native-report evidence ref' };
    }
    return { ok: true, nativeResultRef, observations };
  };
}

/**
 * Leases every currently-leasable `RunStep` for `assessmentRunId` in turn and
 * drives each one through `executeLeasedStep()`, until nothing leasable is left —
 * same drain-once, no-poll-loop shape as `runPromptfooWorkerOnce()`, including its
 * грань №19 concurrency precheck — see that function's doc comment for the mechanism.
 */
export async function runDuoStaticWorkerOnce(
  deps: DuoStaticWorkerDeps,
  config: DuoStaticWorkerConfig,
  assessmentRunId: string,
  owner: string,
  leaseDurationMs: number,
  now: () => Date = () => new Date(),
): Promise<WorkerStepResult[]> {
  const results: WorkerStepResult[] = [];
  const concurrencyBlocked = new Set<string>();

  for (;;) {
    const candidate = deps.runSteps.peekLeasable<RunStepPayload>(assessmentRunId, { excludeIds: [...concurrencyBlocked], now });
    if (!candidate) break;

    if (candidate.campaignId === null || candidate.targetId === null) {
      const step = deps.runSteps.lease<RunStepPayload>(assessmentRunId, { owner, leaseDurationMs, now, stepId: candidate.id });
      if (!step) continue;
      const detail = `RunStep ${step.id} has no campaignId/targetId set — the duo-static worker requires identity at enqueue() time (ARCH_CLAUDE_TRANSFER.md §2.5)`;
      deps.runSteps.fail(step.id, owner, detail, now());
      results.push({ runStepId: step.id, outcome: { outcome: 'MALFORMED_STEP', detail } });
      continue;
    }

    const request = buildDispatchRequest(candidate, candidate.campaignId, candidate.targetId, config);
    const precheck = leaseWithConcurrencyPrecheck<RunStepPayload>(deps.runSteps, deps.scheduler, assessmentRunId, candidate.id, request, { owner, leaseDurationMs, now });
    if (precheck.outcome === 'BLOCKED') {
      concurrencyBlocked.add(candidate.id);
      continue;
    }
    if (precheck.outcome === 'RACED') {
      continue;
    }

    const step = precheck.step;
    const runner = buildDuoStaticStepRunner(
      deps.artifacts,
      { ...config.duoStatic, ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}) },
      { campaignId: candidate.campaignId, assessmentRunId, targetId: candidate.targetId, engineVersion: config.engineVersion, adapterVersion: config.adapterVersion },
      now,
      deps.adapter,
    );

    const outcome = await executeLeasedStep(deps.db, deps.runSteps, deps.attempts, deps.observations, deps.events, deps.scheduler, deps.authProvider, request, runner, owner, now());
    results.push({ runStepId: step.id, outcome });
  }

  return results;
}
