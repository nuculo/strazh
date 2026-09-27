import { targetProbeKey, type CampaignHistoryView } from '../features/history-view.js';
import type { TerminalReason } from '../execution/types.js';
import type { ProbeCatalogEntry } from './catalog.js';

/**
 * ARCH_CLAUDE_TRANSFER.md §2.5 step 3: a settled `ExecutionAttempt` is not the same
 * claim as a committed outcome, and not every `TerminalReason` means the same thing
 * for eligibility. `TARGET_UNAVAILABLE`/`CANCELLED`/`TIMED_OUT_BEFORE_EFFECT`/
 * `FAILED_BEFORE_EFFECT`/`NORMALIZATION_FAILED`/`STALE_LEASE_RESULT` all mean the
 * effect provably never produced a real result — a naive single counter would make
 * `TARGET_UNAVAILABLE` (ordinary resource contention, RTAP's own steady state for a
 * `TARGET_SERIAL` target) permanently unretriable, which is actively harmful, not
 * just imprecise. `COMPLETED`/`OBSERVATION_COMMITTED` are already reflected in
 * `committedOutcomes` — counting them here too would double-penalize.
 * `AUTHORIZATION_DENIED`/`CAPABILITY_UNSUPPORTED`/`UNKNOWN_EFFECT_OUTCOME` are the
 * three that genuinely block: a policy-level refusal, or an effect whose outcome is
 * a "durable business outcome" (`reconciliation.ts`'s own words) requiring an
 * explicit decision, not a retry.
 *
 * Honestly short of the plan's own stated nuance: it describes
 * `AUTHORIZATION_DENIED` as blocking "until policy version changes" and
 * `UNKNOWN_EFFECT_OUTCOME` as blocking "without an explicit operator decision" —
 * neither mechanism (a policy-version comparison, an operator-decision record)
 * exists anywhere in this repo yet, so both simplify to "always blocks" here rather
 * than pretending a conditional reinstatement this codebase cannot yet evaluate.
 *
 * An exhaustive `switch` with a `never` check, matching `execution/settle.ts`'s own
 * `releasesOnSettlement()` — adding a twelfth `TerminalReason` must not compile
 * until someone decides which side of this line it falls on.
 */
export function blocksEligibility(reason: TerminalReason): boolean {
  switch (reason) {
    case 'AUTHORIZATION_DENIED':
    case 'CAPABILITY_UNSUPPORTED':
    case 'UNKNOWN_EFFECT_OUTCOME':
      return true;
    case 'COMPLETED':
    case 'CANCELLED':
    case 'TIMED_OUT_BEFORE_EFFECT':
    case 'TARGET_UNAVAILABLE':
    case 'FAILED_BEFORE_EFFECT':
    case 'NORMALIZATION_FAILED':
    case 'STALE_LEASE_RESULT':
    case 'OBSERVATION_COMMITTED':
      return false;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export interface EligibilityPolicy {
  /** Attempts already committed at or above this count make a non-mandatory probe ineligible. */
  readonly maxAttemptsPerProbe: number;
  /** Don't re-suggest a probe that already produced a confirmed VULNERABLE finding, unless it is mandatory (e.g. a required retest policy). */
  readonly excludeConfirmedVulnerable: boolean;
}

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  maxAttemptsPerProbe: 1,
  excludeConfirmedVulnerable: true,
};

export interface EligibleCandidate {
  readonly targetId: string;
  readonly probeId: string;
  readonly mandatory: boolean;
}

export interface EnumerationResult {
  readonly eligible: EligibleCandidate[];
  readonly excludedReasons: Readonly<Record<string, string>>; // probeId -> reason
}

/**
 * ADAPTIVE_REDTEAM_RUNTIME.md §8: "Eligibility and safety policy" feeding the
 * Candidate Enumerator. Mandatory probes are always eligible — the policy governs
 * everything else. Pure function of (catalog, targetId, history); no I/O, no
 * RunStep access, so this alone cannot influence execution — enumeration is not
 * dispatch.
 *
 * Called once per Target, with `targetId` explicit rather than folded into the
 * catalog — `ProbeCatalogEntry` describes which probes *exist* (target-agnostic),
 * while eligibility ("already attempted", "already confirmed vulnerable") is
 * inherently per-target. A real bug, found by audit: before `targetId` was a
 * parameter here, eligibility was checked against `history.byProbe` — a
 * campaign-wide map keyed by bare `probeId` — so a probe already attempted against
 * Target A was silently excluded for Target B too, even though it had never run
 * there.
 */
export function enumerateEligibleCandidates(
  catalog: readonly ProbeCatalogEntry[],
  targetId: string,
  history: CampaignHistoryView,
  policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
): EnumerationResult {
  const eligible: EligibleCandidate[] = [];
  const excludedReasons: Record<string, string> = {};

  for (const entry of catalog) {
    if (entry.mandatory) {
      eligible.push({ targetId, probeId: entry.probeId, mandatory: true });
      continue;
    }

    const key = targetProbeKey(targetId, entry.probeId);
    const counts = history.byTargetProbe.get(key);
    const attempts = counts?.committedOutcomes ?? 0;

    if (policy.excludeConfirmedVulnerable && history.confirmedFindingTargetProbes.has(key)) {
      excludedReasons[entry.probeId] = 'already-confirmed-vulnerable';
      continue;
    }

    const settled = history.settledAttemptsByReason.get(key);
    const blockingReason = settled
      ? (Object.keys(settled) as TerminalReason[]).find((reason) => settled[reason] > 0 && blocksEligibility(reason))
      : undefined;
    if (blockingReason) {
      excludedReasons[entry.probeId] = `settled-attempt-blocks-retry(${blockingReason})`;
      continue;
    }

    if (attempts >= policy.maxAttemptsPerProbe) {
      excludedReasons[entry.probeId] = `max-attempts-reached(${attempts}/${policy.maxAttemptsPerProbe})`;
      continue;
    }

    eligible.push({ targetId, probeId: entry.probeId, mandatory: false });
  }

  return { eligible, excludedReasons };
}
