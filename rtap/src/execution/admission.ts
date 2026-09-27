import type { LawRegistry } from '../laws/registry.js';

/**
 * EXECUTION_SAFETY_RECOVERY.md §15 — the fourteen criteria that must *all* hold
 * before Phase 5 (controlled planning) is admissible. §16 names "full admission
 * suite" as a 4.5.4 deliverable in its own right: this is that suite, evaluated
 * for real against the current LawRegistry rather than asserted by prose.
 *
 * Criteria 11-12 aren't law-checkable at all — they're about CI configuration and
 * adapter integration. `extraEvidence` lets a caller supply the honest,
 * currently-true answer for those; every field defaults to the actual state of this
 * repository as of 4.5.4, not to an optimistic guess. Criteria 13 and 14 used to be
 * declared fields here too ("a runbook exists," "a feature flag that doesn't exist")
 * — each moved to `lawCriterion()` once a real law existed to check it against:
 * `redteam.platform/runbook-covers-unknown-effect-outcome` for 13,
 * `redteam.execution/rollback-disables-authorization-not-fencing` for 14. A hand-declared
 * boolean can go stale the moment someone deletes the file it was asserting; a law
 * cannot.
 */
export interface AdmissionExtraEvidence {
  /** §15.11: crash matrix runs in CI with replayable seeds. */
  readonly crashMatrixRunsInCi: boolean;
  /** §15.12: all Architecture Laws pass *for the Promptfoo vertical slice* — i.e. promptfoo's own adapter is wired to ExecutionAttemptStore/AuthorizationReceipt/ConcurrencyScheduler, not just standalone mechanism tests. */
  readonly promptfooWiredToHardening: boolean;
}

/** The actual, current, honest state of this repository — see rtap/README.md's Phase 4.5.4 and "A production caller for the Promptfoo vertical slice" sections for why each value is what it is. */
export const CURRENT_EXTRA_EVIDENCE: AdmissionExtraEvidence = {
  crashMatrixRunsInCi: true,
  promptfooWiredToHardening: true,
};

export type AdmissionStatus = 'MET' | 'NOT_MET';

export interface AdmissionCriterion {
  readonly id: number;
  readonly statement: string;
  readonly status: AdmissionStatus;
  readonly detail: string;
}

export interface Phase5AdmissionReport {
  readonly criteria: readonly AdmissionCriterion[];
  readonly admissible: boolean;
}

function lawCriterion(id: number, statement: string, lawId: string, held: (lawId: string) => boolean, detail?: string): AdmissionCriterion {
  const met = held(lawId);
  return { id, statement, status: met ? 'MET' : 'NOT_MET', detail: detail ?? `${met ? 'held' : 'did not hold or is not implemented'}: ${lawId}` };
}

export async function evaluatePhase5Admission(registry: LawRegistry, extra: AdmissionExtraEvidence = CURRENT_EXTRA_EVIDENCE, seed = 1): Promise<Phase5AdmissionReport> {
  const report = await registry.runAll(seed);
  const held = (lawId: string): boolean => report.results.some((r) => r.id === lawId && r.status === 'implemented' && r.held);

  const criteria: AdmissionCriterion[] = [
    lawCriterion(1, 'A late result from a previous lease generation is rejected atomically.', 'redteam.execution/late-result-from-old-lease-is-rejected', held),
    {
      id: 2,
      statement: 'Every Observation contains a binding to an active ExecutionAttempt.',
      status: held('redteam.execution/observation-binds-active-attempt') && extra.promptfooWiredToHardening ? 'MET' : 'NOT_MET',
      detail: 'The binding mechanism (commitFencedObservation) is proven correct in isolation, and executeLeasedStep() now composes it with admission/fencing/settlement in one place — test/integration/executor-slice.test.ts drives a real promptfoo result through it and asserts the committed Observation carries its executionAttemptId. What is still missing is a production caller of that executor; see criterion 12.',
    },
    lawCriterion(3, 'Blind retry after an unknown external effect is absent.', 'redteam.execution/unknown-effect-is-not-auto-retried', held),
    lawCriterion(4, 'Recovery policy is derived from versioned adapter operation capability.', 'redteam.execution/retry-follows-adapter-capability', held),
    lawCriterion(5, 'A crash between effect and canonical commit is correctly reconciled.', 'redteam.execution/recovery-preserves-single-observation', held),
    lawCriterion(6, 'A crash after Observation commit never creates a duplicate Observation/Event.', 'redteam.execution/recovery-preserves-single-observation', held),
    lawCriterion(7, 'UNKNOWN concurrency executes as EXCLUSIVE.', 'redteam.execution/unknown-concurrency-is-exclusive', held),
    lawCriterion(8, 'An AuthorizationReceipt is bound to immutable target/policy/adapter snapshots.', 'redteam.execution/authorization-precedes-effect', held),
    lawCriterion(9, 'Interceptor order is deterministic and enters provenance.', 'redteam.execution/interceptor-order-is-deterministic', held),
    lawCriterion(10, 'OperationalEnvelope traces the path without telemetry becoming authority.', 'redteam.execution/telemetry-is-not-authority', held),
    {
      id: 11,
      statement: 'The crash matrix runs in CI with replayable seeds.',
      status: extra.crashMatrixRunsInCi ? 'MET' : 'NOT_MET',
      detail: extra.crashMatrixRunsInCi ? '.github/workflows/rtap-ci.yml runs the full test suite (including test/execution/crash-kill-points.test.ts) and npm run laws on every push/PR.' : 'no CI configuration exists.',
    },
    {
      id: 12,
      statement: 'All Architecture Laws pass for the Promptfoo vertical slice.',
      status: extra.promptfooWiredToHardening ? 'MET' : 'NOT_MET',
      detail: extra.promptfooWiredToHardening
        ? "executeLeasedStep() (execution/run-step-executor.ts) is the single composition of admission, dispatch, fenced commit and settlement. worker/promptfoo-worker.ts closes the exact gap this criterion's own detail used to name — composes it with a real PromptfooCliAdapter — no execFn/readFileFn injection in production — and worker/cli.ts is a real, non-test entry point that opens a real file-backed database and calls it. adapters/promptfoo/run.ts is still unchanged by design (the engine composition is a caller-supplied StepRunner closure, which is what keeps the executor free of adapter imports); what changed is that the closure and its caller now both live in src/worker/, not only in a test."
        : "executeLeasedStep() (execution/run-step-executor.ts) is now the single composition of admission, dispatch, fenced commit and settlement, and test/integration/executor-slice.test.ts drives a real promptfoo result end to end through it — so the laws are no longer proven only against synthetic scenarios. Still NOT_MET, deliberately and on two counts: adapters/promptfoo/run.ts is unchanged *by design* (it stays an ExecFn-injectable CLI wrapper; the engine composition is a caller-supplied StepRunner closure, which is what keeps the executor free of adapter imports), and that closure lives in a test rather than in a production entry point — there is no bin/ or service loop calling executeLeasedStep() yet. This flag is declared evidence about a real deployment, not something derivable from the law registry, so it stays false until a production caller exists.",
    },
    lawCriterion(
      13,
      'A runbook describes manual resolution of UNKNOWN_EFFECT_OUTCOME.',
      'redteam.platform/runbook-covers-unknown-effect-outcome',
      held,
      "rtap/RUNBOOK.md's own content is checked directly, not asserted — the law reads the file (readFileSync, resolved relative to the law module's own path, not process.cwd()) and requires it to mention UNKNOWN_EFFECT_OUTCOME, carry a named \"Part A\" section, and use language identifying the procedure as an operator's manual action. A deleted or gutted RUNBOOK.md fails this criterion the next time the law registry runs; a hand-declared boolean would have kept reporting MET regardless.",
    ),
    lawCriterion(
      14,
      'A rollback drill proves disabling the hardening feature flag does not weaken fencing of already-started attempts.',
      'redteam.execution/rollback-disables-authorization-not-fencing',
      held,
      "admitDispatch() (execution/dispatch.ts) gained a HardeningConfig parameter — authorizationEnforced: false skips only evaluateAuthorization(); concurrency reservation stays unconditional and fencing (execution-attempt-store.ts's bindNativeResult(), Phase 4.5.1) doesn't accept this config at all, so there is no code path by which disabling it could reach fencing. The law proves both halves: bypass genuinely disables authorization (for either rejection reason), and a bypass-admitted attempt is still rejected as STALE_LEASE_RESULT once its lease is superseded, identically to one admitted while enforced. HARDENING_ENFORCED is the only value any real caller uses — nothing in worker/ or any production path constructs a disabled one; this exists to make the property provable, not to give an operator a working bypass switch.",
    ),
  ];

  return { criteria, admissible: criteria.every((c) => c.status === 'MET') };
}
