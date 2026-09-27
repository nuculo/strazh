import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthorizationProvider, Principal, Role } from '../authz/types.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { CampaignEventStore } from '../events/store.js';
import type { ObservationStore } from '../observations/store.js';
import type { RunStepStore } from '../runsteps/store.js';
import type { RunStep, RunStepPayload } from '../runsteps/types.js';
import type { ExecutionAttemptStore } from '../execution/execution-attempt-store.js';
import type { ConcurrencyScheduler } from '../execution/concurrency-scheduler.js';
import type { ConcurrencyClass } from '../execution/types.js';
import type { DispatchGuardRequest } from '../execution/dispatch.js';
import { executeLeasedStep, leaseWithConcurrencyPrecheck, type StepResult, type StepRunner } from '../execution/run-step-executor.js';
import { PromptfooCliAdapter, type PromptfooRunOptions } from '../adapters/promptfoo/run.js';
import type { SandboxProfile } from '../execution/sandbox.js';
import { parsePromptfooResult } from '../adapters/promptfoo/parse.js';
import { materializePromptfooEvidence } from '../adapters/promptfoo/evidence.js';
import { eventForObservation } from '../pipeline/observation-event.js';

/**
 * ARCH_CLAUDE_TRANSFER.md §2.3's own doc comment on `executeLeasedStep()`: "the
 * process-level lease loop stays a thin caller (a future `bin/`)." This is that
 * caller's actual composition, specific to the promptfoo engine — §15 criterion 12
 * names it exactly: "All Architecture Laws pass for the Promptfoo vertical slice."
 * `PromptfooWorkerConfig` is the deployment-fixed policy `executeLeasedStep()` needs
 * but no RunStep payload carries, matching what `test/integration/executor-slice.test.ts`
 * hardcoded per call — a real worker fixes it once per process instead.
 */
export interface PromptfooWorkerConfig {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly policyRevision: string;
  /**
   * Used as both `declaredCapabilityDigest` and `expectedCapabilityDigest` — this
   * single-process worker is the sole source of both, so by construction they always
   * match. A real cross-process authorization/dispatch split would need this to come
   * from two independent places; nothing in this repo does that yet.
   */
  readonly capabilityDigest: string;
  readonly sandboxProfileRef: string;
  readonly egressPolicyRef: string;
  readonly receiptDurationMs: number;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly concurrencyClass: ConcurrencyClass;
  readonly artifactsDir: string;
  readonly promptfoo: Pick<PromptfooRunOptions, 'configPath' | 'outputPath' | 'binPath' | 'cwd' | 'subcommand' | 'timeoutMs'>;
  /**
   * грань №15: the real privilege/env scoping applied to the actual `execFile()` call
   * — distinct from `sandboxProfileRef` above, which stays what it always was, an
   * opaque identifier recorded on the `AuthorizationReceipt`, not something read for
   * enforcement. Optional: omitted means the adapter's own default
   * (`minimalSandboxProfile()`, `PATH` only) applies, which is already scoped, not
   * full inheritance from this worker process's own environment.
   */
  readonly sandbox?: SandboxProfile;
}

export interface PromptfooWorkerDeps {
  readonly db: DatabaseSync;
  readonly runSteps: RunStepStore;
  readonly attempts: ExecutionAttemptStore;
  readonly observations: ObservationStore;
  readonly events: CampaignEventStore;
  readonly scheduler: ConcurrencyScheduler;
  readonly authProvider: AuthorizationProvider;
  readonly artifacts: ArtifactStore;
  /** Injectable for tests, exactly like `test/integration/executor-slice.test.ts`'s own seam. Defaults to a real `PromptfooCliAdapter` — real `execFile`/`readFile`. */
  readonly adapter?: PromptfooCliAdapter;
}

/**
 * Not `admitDispatch()`'s job to reject — a leased step with no identity is a
 * data-integrity problem the worker itself must refuse, before it can even build a
 * `DispatchGuardRequest` (no `campaignId`/`targetId` to put in one).
 */
export interface MalformedStepOutcome {
  readonly outcome: 'MALFORMED_STEP';
  readonly detail: string;
}

export interface WorkerStepResult {
  readonly runStepId: string;
  readonly outcome: StepResult | MalformedStepOutcome;
}

function principalOf(config: PromptfooWorkerConfig): Principal {
  return { subjectId: config.subjectId, tenantId: config.tenantId, roles: config.roles };
}

/**
 * Pure — derives everything `executeLeasedStep()` needs to know about *this*
 * dispatch from the leased step plus the worker's fixed policy. `targetSnapshotRef`
 * has no real snapshot subsystem behind it yet (same honest gap as
 * `sandboxProfileRef`/`egressPolicyRef` — required, opaque, not yet resolved from
 * anywhere real); `targetId` is the best available stand-in, not a placeholder.
 */
export function buildDispatchRequest(step: RunStep<RunStepPayload>, campaignId: string, targetId: string, config: PromptfooWorkerConfig): DispatchGuardRequest {
  return {
    authorization: {
      principal: principalOf(config),
      resourceTenantId: config.tenantId,
      campaignId,
      assessmentRunId: step.assessmentRunId,
      runStepId: step.id,
      operationFamily: 'llm-attack',
      targetSnapshotRef: targetId,
      adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: config.adapterVersion },
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
        // No cancellation mechanism exists — PromptfooCliAdapter.run() awaits
        // execFile() to completion with no AbortSignal wired through.
        supportsCancellation: false,
        // A redteam run sends real attack traffic at a real target.
        destructive: true,
        rateLimitScope: null,
      },
    ],
    attemptStart: {
      assessmentRunId: step.assessmentRunId,
      runStepId: step.id,
      engineAdapterId: 'promptfoo',
      engineAdapterVersion: config.adapterVersion,
      engineRequestId: randomUUID(),
    },
  };
}

export interface PromptfooStepContext {
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly targetId: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
  /**
   * RTAP's own probe identity for this RunStep (from `RunStepPayload.probeId`). When
   * present it is authoritative for the resulting Observation's `probeId`, keeping two
   * distinctly-scheduled probes distinct even if they share native promptfoo metadata.
   * Optional so pre-existing callers/tests that never set it keep native derivation.
   */
  readonly probeId?: string;
}

/**
 * The engine composition, as `run-step-executor.ts`'s own doc comment names it: "a
 * real `bin/` would build this once per engine and hand it to the same executor."
 * One promptfoo invocation is assumed to answer exactly one RunStep — a config
 * scoped to a single probe/target, not a batch. `results.length !== 1` is refused
 * rather than guessed at (`NORMALIZATION_FAILED`), since nothing in this repo maps
 * a promptfoo result index back to a specific RunStep.
 */
export function buildPromptfooStepRunner(
  artifacts: ArtifactStore,
  promptfooOptions: PromptfooRunOptions,
  ctx: PromptfooStepContext,
  now: () => Date = () => new Date(),
  adapter: PromptfooCliAdapter = new PromptfooCliAdapter(),
): StepRunner {
  return async () => {
    const runResult = await adapter.run(promptfooOptions);
    if (!runResult.ok) {
      return { ok: false, terminalReason: 'FAILED_BEFORE_EFFECT', detail: runResult.error };
    }
    if (runResult.output.results.length !== 1) {
      return {
        ok: false,
        terminalReason: 'NORMALIZATION_FAILED',
        detail: `expected exactly one promptfoo result for a single-probe RunStep, got ${runResult.output.results.length}`,
      };
    }

    const native = runResult.output.results[0]!;
    const parsed = parsePromptfooResult(native, 0, {
      assessmentRunId: ctx.assessmentRunId,
      targetId: ctx.targetId,
      nativeRunId: runResult.output.evalId ?? 'unknown',
      engineVersion: ctx.engineVersion,
      adapterVersion: ctx.adapterVersion,
      ...(ctx.probeId !== undefined ? { probeId: ctx.probeId } : {}),
    });
    const withEvidence = await materializePromptfooEvidence(artifacts, parsed, native);

    return {
      ok: true,
      nativeResultRef: withEvidence.evidenceRefs[0]!.ref,
      observations: [
        {
          observation: withEvidence as never,
          event: eventForObservation(withEvidence as never, { campaignId: ctx.campaignId, assessmentRunId: ctx.assessmentRunId, occurredAt: now().toISOString() }),
        },
      ],
    };
  };
}

/**
 * Leases every currently-leasable `RunStep` for `assessmentRunId` in turn and drives
 * each one through `executeLeasedStep()`, until nothing leasable is left — i.e.
 * drains the queue once, rather than polling forever. A long-running daemon is a
 * thin wrapper around calling this repeatedly on an interval; that wrapper is not
 * built here, since nothing in §15 requires it and a poll loop needs its own testing
 * (signal handling, interval config) this change does not need to take on.
 *
 * грань №19: peeks a candidate before leasing it, so a step that would only get
 * CONCURRENCY-refused by `executeLeasedStep()`'s `admitDispatch()` call anyway never
 * pays a wasted `lease_generation` bump — see `leaseWithConcurrencyPrecheck()`'s doc
 * comment. A concurrency-blocked candidate is skipped (not leased) for the rest of
 * this drain pass and re-examined on the next call, so this pass keeps making
 * progress on whatever else is leasable instead of retrying the same blocked step.
 */
export async function runPromptfooWorkerOnce(
  deps: PromptfooWorkerDeps,
  config: PromptfooWorkerConfig,
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
      if (!step) continue; // raced away between peek and lease — try again
      const detail = `RunStep ${step.id} has no campaignId/targetId set — the promptfoo worker requires identity at enqueue() time (ARCH_CLAUDE_TRANSFER.md §2.5)`;
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
    const probeId = step.payload?.probeId;
    const runner = buildPromptfooStepRunner(
      deps.artifacts,
      { ...config.promptfoo, ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}) },
      {
        campaignId: candidate.campaignId,
        assessmentRunId,
        targetId: candidate.targetId,
        engineVersion: config.engineVersion,
        adapterVersion: config.adapterVersion,
        ...(typeof probeId === 'string' && probeId.length > 0 ? { probeId } : {}),
      },
      now,
      deps.adapter,
    );

    const outcome = await executeLeasedStep(deps.db, deps.runSteps, deps.attempts, deps.observations, deps.events, deps.scheduler, deps.authProvider, request, runner, owner, now());
    results.push({ runStepId: step.id, outcome });
  }

  return results;
}
