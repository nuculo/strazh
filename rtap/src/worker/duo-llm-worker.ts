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
import { DuoLlmCliAdapter, type DuoLlmRunOptions } from '../adapters/duo-llm/run.js';
import type { SandboxProfile } from '../execution/sandbox.js';
import { parseDuoLlmRedteamReport, type ParseContext } from '../adapters/duo-llm/parse.js';
import { materializeDuoLlmEvidence } from '../adapters/duo-llm/evidence.js';
import { eventForObservation } from '../pipeline/observation-event.js';

/**
 * грань №17: the same composition as `promptfoo-worker.ts`/`duo-static-worker.ts`
 * (see either's doc comment for the shared mechanism), for duo-llm — with one
 * more real difference: `DuoLlmCliAdapter.run()` is capability-gated
 * (`adapters/capability.ts`) and, as of Phase R, ALL four `DECLARED_CAPABILITIES`
 * are `false` — every single dispatch through this worker resolves to
 * `{ok:false, rejectedCapabilities: [...]}` before `execFn` is ever touched, and
 * this runner maps that to the purpose-built `CAPABILITY_UNSUPPORTED`
 * `StepFailureReason` (not a generic `FAILED_BEFORE_EFFECT`) so the RunStep's own
 * failure record says *why*, precisely.
 *
 * This is deliberately still worth building, not dead weight: `duo-llm/run.ts`'s
 * own doc comment frames its invocation logic as built to real-invocation-shape
 * fidelity specifically so "flipping any capability to true later is a one-line
 * change here, not a rewrite" — this worker is the next link in that same chain.
 * Today it only ever produces `CAPABILITY_UNSUPPORTED`-terminated RunSteps,
 * deterministically, forever, until ARCHITECTURE.md §9 Phase R's four gates are
 * met on `duo-agents`' own side; the moment they are, this file needs no change
 * at all — only `duo-llm/run.ts`'s `DECLARED_CAPABILITIES` does.
 */
export interface DuoLlmWorkerConfig {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly roles: readonly Role[];
  readonly policyRevision: string;
  readonly capabilityDigest: string;
  readonly sandboxProfileRef: string;
  readonly egressPolicyRef: string;
  readonly receiptDurationMs: number;
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly concurrencyClass: ConcurrencyClass;
  readonly artifactsDir: string;
  readonly duoLlm: Pick<DuoLlmRunOptions, 'purpose' | 'plugins' | 'strategies' | 'domains' | 'attacksPerPlugin' | 'outputPath' | 'binPath' | 'cwd'>;
  readonly sandbox?: SandboxProfile;
}

export interface DuoLlmWorkerDeps {
  readonly db: DatabaseSync;
  readonly runSteps: RunStepStore;
  readonly attempts: ExecutionAttemptStore;
  readonly observations: ObservationStore;
  readonly events: CampaignEventStore;
  readonly scheduler: ConcurrencyScheduler;
  readonly authProvider: AuthorizationProvider;
  readonly artifacts: ArtifactStore;
  /** Injectable for tests. Defaults to a real `DuoLlmCliAdapter` — capability-gated before any `execFn` call, real or not. */
  readonly adapter?: DuoLlmCliAdapter;
}

export interface MalformedStepOutcome {
  readonly outcome: 'MALFORMED_STEP';
  readonly detail: string;
}

export interface WorkerStepResult {
  readonly runStepId: string;
  readonly outcome: StepResult | MalformedStepOutcome;
}

function principalOf(config: DuoLlmWorkerConfig): Principal {
  return { subjectId: config.subjectId, tenantId: config.tenantId, roles: config.roles };
}

/**
 * `operationFamily: 'duo-llm-attack'` is deliberately distinct from promptfoo's
 * `'llm-attack'` — RUNBOOK.md Part C's own example names "gating a duo-llm
 * operation family" specifically as a plausible future `ApprovalPolicy` target,
 * which only works if duo-llm dispatches carry a family value an operator can
 * actually match on their own, not one shared with every other LLM-attack
 * engine. `destructive: true` — same as promptfoo, real (if currently always
 * rejected) attack traffic at a live target, unlike duo-static's read-only scan.
 */
export function buildDispatchRequest(step: RunStep<RunStepPayload>, campaignId: string, targetId: string, config: DuoLlmWorkerConfig): DispatchGuardRequest {
  return {
    authorization: {
      principal: principalOf(config),
      resourceTenantId: config.tenantId,
      campaignId,
      assessmentRunId: step.assessmentRunId,
      runStepId: step.id,
      operationFamily: 'duo-llm-attack',
      targetSnapshotRef: targetId,
      adapterIdentity: { engineAdapterId: 'duo-llm', engineAdapterVersion: config.adapterVersion },
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
        destructive: true,
        rateLimitScope: null,
      },
    ],
    attemptStart: {
      assessmentRunId: step.assessmentRunId,
      runStepId: step.id,
      engineAdapterId: 'duo-llm',
      engineAdapterVersion: config.adapterVersion,
      engineRequestId: randomUUID(),
    },
  };
}

export interface DuoLlmStepContext {
  readonly campaignId: string;
  readonly assessmentRunId: string;
  readonly targetId: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
}

/**
 * `DuoLlmCliAdapter.run()` checks capabilities as its first statement, before
 * `execFn` is ever touched — its `{ok:false, rejectedCapabilities}` branch is
 * distinguished from a generic dispatch failure (`{ok:false, error}` with no
 * `rejectedCapabilities`) so this runner can classify precisely: the quarantine
 * is `CAPABILITY_UNSUPPORTED`, not `FAILED_BEFORE_EFFECT` — the effect genuinely
 * never had a chance to start, for a specific, named, structural reason.
 */
export function buildDuoLlmStepRunner(
  artifacts: ArtifactStore,
  runOptions: DuoLlmRunOptions,
  ctx: DuoLlmStepContext,
  now: () => Date = () => new Date(),
  adapter: DuoLlmCliAdapter = new DuoLlmCliAdapter(),
): StepRunner {
  return async () => {
    const runResult = await adapter.run(runOptions);
    if (!runResult.ok) {
      if (runResult.rejectedCapabilities) {
        return { ok: false, terminalReason: 'CAPABILITY_UNSUPPORTED', detail: runResult.error };
      }
      return { ok: false, terminalReason: 'FAILED_BEFORE_EFFECT', detail: runResult.error };
    }

    const { report } = runResult;

    if (report.results.length === 0) {
      const [nativeRef] = await materializeEvidence(artifacts, ctx.assessmentRunId, [{ kind: 'native-report', body: JSON.stringify(report) }]);
      return { ok: true, nativeResultRef: nativeRef!.ref, observations: [] };
    }

    const parseCtx: ParseContext = {
      assessmentRunId: ctx.assessmentRunId,
      targetId: ctx.targetId,
      engineVersion: ctx.engineVersion,
      adapterVersion: ctx.adapterVersion,
    };
    const parsedObservations = parseDuoLlmRedteamReport(report, parseCtx);
    const occurredAt = now().toISOString();

    let nativeResultRef: string | undefined;
    const observations: ObservationEventPair[] = [];
    for (let i = 0; i < parsedObservations.length; i += 1) {
      const parsed = parsedObservations[i]!;
      const result = report.results[i]!;
      const withEvidence = await materializeDuoLlmEvidence(artifacts, parsed, result, report);
      if (nativeResultRef === undefined) {
        nativeResultRef = withEvidence.evidenceRefs.find((r) => r.kind === 'native-report')?.ref;
      }
      observations.push({
        observation: withEvidence as never,
        event: eventForObservation(withEvidence as never, { campaignId: ctx.campaignId, assessmentRunId: ctx.assessmentRunId, occurredAt }),
      });
    }

    if (!nativeResultRef) {
      return { ok: false, terminalReason: 'NORMALIZATION_FAILED', detail: 'materializeDuoLlmEvidence() did not produce a native-report evidence ref' };
    }
    return { ok: true, nativeResultRef, observations };
  };
}

/**
 * Same drain-once, no-poll-loop shape as `runPromptfooWorkerOnce()`/
 * `runDuoStaticWorkerOnce()`, including its грань №19 concurrency precheck — see
 * that function's doc comment for the mechanism. Every leased step will, today,
 * settle `FAILED` with `CAPABILITY_UNSUPPORTED` — that is this worker doing its job
 * correctly, not a sign anything is broken (see this module's own doc comment).
 */
export async function runDuoLlmWorkerOnce(
  deps: DuoLlmWorkerDeps,
  config: DuoLlmWorkerConfig,
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
      const detail = `RunStep ${step.id} has no campaignId/targetId set — the duo-llm worker requires identity at enqueue() time (ARCH_CLAUDE_TRANSFER.md §2.5)`;
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
    const runner = buildDuoLlmStepRunner(
      deps.artifacts,
      { ...config.duoLlm, ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}) },
      { campaignId: candidate.campaignId, assessmentRunId, targetId: candidate.targetId, engineVersion: config.engineVersion, adapterVersion: config.adapterVersion },
      now,
      deps.adapter,
    );

    const outcome = await executeLeasedStep(deps.db, deps.runSteps, deps.attempts, deps.observations, deps.events, deps.scheduler, deps.authProvider, request, runner, owner, now());
    results.push({ runStepId: step.id, outcome });
  }

  return results;
}
