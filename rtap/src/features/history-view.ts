import type { CampaignEventEnvelope } from '../events/store.js';
import type { ExecutionAttempt, TerminalReason } from '../execution/types.js';
import type { RunStepStore } from '../runsteps/store.js';
import type { RunStepPayload } from '../runsteps/types.js';

/**
 * "World-before-execution" reconstruction — ADAPTIVE_REDTEAM_RUNTIME.md §7: "Training
 * uses the world state *before* the candidate was executed." This is a lightweight,
 * RTAP-side view built directly from already-committed CampaignEvents (real
 * infrastructure since Phase 1), not the full Frozen CampaignWorld graph/replay
 * engine (that's Phase 4). It answers exactly what FeatureCompiler §4.1's `history:
 * CampaignHistoryView` parameter needs: what has this campaign already tried, and
 * with what outcome, strictly before a given point in time.
 */
export interface ProbeOutcomeCounts {
  /**
   * ARCH_CLAUDE_TRANSFER.md §2.5: renamed from `attempts` — this counts committed
   * `CampaignEvent`s, never anything from `execution_attempts`. The name `attempts`
   * was the exact "two terminal models, precision lost in translation" defect the
   * doc names: an attempt that ended `AUTHORIZATION_DENIED`/`TARGET_UNAVAILABLE`/
   * `UNKNOWN_EFFECT_OUTCOME` never commits an event, so it was invisible here and
   * read by `enumerateEligibleCandidates()` as "never tried" — see
   * `CampaignHistoryView.settledAttemptsByReason` for the other half.
   */
  readonly committedOutcomes: number;
  readonly vulnerable: number;
  readonly resistant: number;
  readonly unverified: number;
  readonly error: number;
}

export interface CampaignHistoryView {
  readonly campaignId: string;
  /** Exclusive upper bound — events with this sequence or later were not consumed. */
  readonly asOfSequence: number;
  readonly totalEventsConsumed: number;
  /**
   * Keyed by `targetProbeKey(targetId, probeId)` — a probe's attempt/outcome
   * history is scoped to the target it was run against. A confirmed VULNERABLE on
   * Target A must never suppress or re-trigger eligibility for the same probe
   * against Target B; probes attack a specific target, so "already tried" only
   * means something within one target. This was a real bug: before this field
   * existed, `byProbe` was keyed by bare `probeId` and silently conflated every
   * target's history for the same probe.
   */
  readonly byTargetProbe: ReadonlyMap<string, ProbeOutcomeCounts>;
  readonly byTarget: ReadonlyMap<string, ProbeOutcomeCounts>;
  /**
   * Deliberately campaign-wide, not target-scoped — this answers "has this
   * vulnerability class been explored anywhere in the engagement," a diversity/
   * feature signal, not an eligibility gate. Nothing reads this to decide whether a
   * probe may run again, so target-blindness here is an intentional design choice,
   * not the bug `byTargetProbe` exists to fix.
   */
  readonly vulnerabilityClassesSeen: ReadonlySet<string>;
  /** Keyed by `targetProbeKey(targetId, probeId)` — see `byTargetProbe`. */
  readonly confirmedFindingTargetProbes: ReadonlySet<string>;
  /**
   * ARCH_CLAUDE_TRANSFER.md §2.5's other half: `ExecutionAttempt.terminalReason`,
   * read verbatim from `execution_attempts` — never collapsed into the boolean
   * `byTargetProbe` already is. Keyed by `targetProbeKey(targetId, probeId)`, same
   * convention as `byTargetProbe`. Empty (all-zero `Record`) for any key with no
   * settled attempts, same as `byTargetProbe` being simply absent for a key with no
   * committed events — see `buildSettledAttemptsByReason()` for how this is
   * actually populated; `buildHistoryView()` itself stays pure and never touches
   * `execution_attempts`.
   */
  readonly settledAttemptsByReason: ReadonlyMap<string, Readonly<Record<TerminalReason, number>>>;
}

const ZERO_TERMINAL_REASON_COUNTS: Readonly<Record<TerminalReason, number>> = {
  COMPLETED: 0,
  CANCELLED: 0,
  TIMED_OUT_BEFORE_EFFECT: 0,
  AUTHORIZATION_DENIED: 0,
  CAPABILITY_UNSUPPORTED: 0,
  TARGET_UNAVAILABLE: 0,
  FAILED_BEFORE_EFFECT: 0,
  UNKNOWN_EFFECT_OUTCOME: 0,
  NORMALIZATION_FAILED: 0,
  STALE_LEASE_RESULT: 0,
  OBSERVATION_COMMITTED: 0,
};

/**
 * `JSON.stringify` rather than a plain `${targetId}:${probeId}` join — probeId
 * legitimately contains `:` (e.g. `"sql-injection:strategy-1"`), so a naive join
 * risks two different (targetId, probeId) pairs colliding on the same key.
 */
export function targetProbeKey(targetId: string, probeId: string): string {
  return JSON.stringify([targetId, probeId]);
}

const EMPTY_COUNTS: ProbeOutcomeCounts = { committedOutcomes: 0, vulnerable: 0, resistant: 0, unverified: 0, error: 0 };

function bump(counts: ProbeOutcomeCounts, verdict: string): ProbeOutcomeCounts {
  return {
    committedOutcomes: counts.committedOutcomes + 1,
    vulnerable: counts.vulnerable + (verdict === 'VULNERABLE' ? 1 : 0),
    resistant: counts.resistant + (verdict === 'RESISTANT' ? 1 : 0),
    unverified: counts.unverified + (verdict === 'UNVERIFIED' ? 1 : 0),
    error: counts.error + (verdict === 'ERROR' ? 1 : 0),
  };
}

/** vulnerabilityClass is the part of probeId before the strategy — see parsePromptfooResult. */
export function vulnerabilityClassOf(probeId: string): string {
  return probeId.split(':')[0] ?? probeId;
}

/** strategy is the part of probeId after the vulnerability class, e.g. "base64" in "prompt-injection:base64". */
export function strategyOf(probeId: string): string {
  return probeId.split(':')[1] ?? 'default';
}

/**
 * Builds the view strictly from events with `sequence < asOfSequence`. Events at or
 * after `asOfSequence` are exactly the ones this reconstruction must not see — using
 * them would leak the outcome being predicted back into the "before" view.
 *
 * `settledAttemptsByReason` is an optional, trailing, purely additive parameter —
 * every existing caller keeps working unchanged and gets an empty map, same as
 * before this field existed. It is deliberately not computed here: doing so would
 * make this function reach into `execution_attempts`, and it stays a pure function
 * of an event array precisely so it can keep being tested and called that way. A
 * real caller composes it first via `buildSettledAttemptsByReason()` and passes it
 * in.
 */
export function buildHistoryView(
  events: readonly CampaignEventEnvelope[],
  campaignId: string,
  asOfSequence: number,
  settledAttemptsByReason: ReadonlyMap<string, Readonly<Record<TerminalReason, number>>> = new Map(),
): CampaignHistoryView {
  const byTargetProbe = new Map<string, ProbeOutcomeCounts>();
  const byTarget = new Map<string, ProbeOutcomeCounts>();
  const vulnerabilityClassesSeen = new Set<string>();
  const confirmedFindingTargetProbes = new Set<string>();
  let consumed = 0;

  for (const event of events) {
    if (event.campaignId !== campaignId) continue;
    if (event.sequence >= asOfSequence) continue;
    const payload = event.payload as { targetId?: unknown; probeId?: unknown; verdict?: unknown };
    if (typeof payload.probeId !== 'string' || typeof payload.verdict !== 'string') continue;

    consumed += 1;
    vulnerabilityClassesSeen.add(vulnerabilityClassOf(payload.probeId));

    if (typeof payload.targetId === 'string') {
      byTarget.set(payload.targetId, bump(byTarget.get(payload.targetId) ?? EMPTY_COUNTS, payload.verdict));

      const key = targetProbeKey(payload.targetId, payload.probeId);
      byTargetProbe.set(key, bump(byTargetProbe.get(key) ?? EMPTY_COUNTS, payload.verdict));
      if (payload.verdict === 'VULNERABLE') confirmedFindingTargetProbes.add(key);
    }
  }

  return {
    campaignId,
    asOfSequence,
    totalEventsConsumed: consumed,
    byTargetProbe,
    byTarget,
    vulnerabilityClassesSeen,
    confirmedFindingTargetProbes,
    settledAttemptsByReason,
  };
}

/**
 * ARCH_CLAUDE_TRANSFER.md §2.5's DB-touching half: given every `ExecutionAttempt`
 * recorded for a campaign (`ExecutionAttemptStore.listByCampaign()`), groups the
 * *settled* ones (`terminalReason !== null`) by `targetProbeKey(targetId, probeId)`
 * and counts each `TerminalReason` verbatim. `probeId` is not a column on
 * `execution_attempts` — it lives only in the `RunStep.payload` JSON blob a real
 * dispatch wrote (`RunStepPayload`) — so this looks each attempt's `RunStep` up via
 * `runSteps.get()` to read it back out; an attempt whose payload does not
 * structurally match `RunStepPayload` (every caller that predates this, every law
 * fixture) is silently excluded, the same "not every RunStep has an identity" gap
 * `campaignId`/`targetId` being nullable already documents, not a new one.
 */
export function buildSettledAttemptsByReason(
  attempts: readonly ExecutionAttempt[],
  runSteps: RunStepStore,
): ReadonlyMap<string, Readonly<Record<TerminalReason, number>>> {
  const byKey = new Map<string, Record<TerminalReason, number>>();

  for (const attempt of attempts) {
    if (attempt.terminalReason === null) continue;
    if (attempt.targetId === null) continue;

    const step = runSteps.get(attempt.runStepId);
    const payload = step?.payload as Partial<RunStepPayload> | undefined;
    if (typeof payload?.probeId !== 'string') continue;

    const key = targetProbeKey(attempt.targetId, payload.probeId);
    const counts = byKey.get(key) ?? { ...ZERO_TERMINAL_REASON_COUNTS };
    counts[attempt.terminalReason] += 1;
    byKey.set(key, counts);
  }

  return byKey;
}
