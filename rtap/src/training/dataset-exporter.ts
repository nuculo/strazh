import type { CampaignEventEnvelope } from '../events/store.js';
import { buildHistoryView } from '../features/history-view.js';
import { compileCandidateFeatures, type CandidateFeatureSnapshot, type BudgetState } from '../features/candidate-compiler.js';
import { computeUtilityLabel, DEFAULT_UTILITY_POLICY, type UtilityLabelPolicy } from './utility-label-policy.js';
import type { ObservationForFeatures } from '../features/observation-compiler.js';

export interface HistoricalRecord {
  readonly observation: ObservationForFeatures;
  readonly event: CampaignEventEnvelope;
}

export interface TrainingExample {
  readonly campaignId: string;
  readonly targetId: string;
  readonly probeId: string;
  readonly occurredAt: string;
  readonly features: CandidateFeatureSnapshot;
  readonly label: number;
}

export interface DatasetExportResult {
  readonly examples: TrainingExample[];
  readonly excludedCount: number;
  readonly excludedReasons: Readonly<Record<string, number>>;
}

export interface DatasetExportOptions {
  readonly policy?: UtilityLabelPolicy;
  readonly resolveBudget?: (campaignId: string, asOfSequence: number) => BudgetState;
}

const NO_BUDGET_TRACKED: BudgetState = { targetCallsUsed: 0, targetCallsBudget: 0 }; // budget coordinate resolves to MISSING

/**
 * FROZEN_INTEGRATION.md §12 F2 "promptfoo dataset exporter". Turns already-committed
 * history (real, from Phase 1's stores) into `TrainingExample`s: a `CandidateFeatureSnapshot`
 * reconstructed strictly *before* the probe ran (ADAPTIVE_REDTEAM_RUNTIME.md §7),
 * paired with the label `computeUtilityLabel` derives from what actually happened.
 *
 * Excludes, per FROZEN_INTEGRATION.md §8.1: duo `defaulted-pass`, config-ignored
 * runs, and (defensively, though this repo's own adapters should never produce it)
 * a RESISTANT verdict with no grader at all — a transport failure mislabeled as a
 * negative result. Not yet implemented: excluding "unreviewed Critical outcomes" —
 * Phase 1's Observation has no severity/review-status field to check against; this
 * exclusion is a documented no-op today, not silently skipped.
 */
export function exportDataset(
  records: readonly HistoricalRecord[],
  allEvents: readonly CampaignEventEnvelope[],
  options: DatasetExportOptions = {},
): DatasetExportResult {
  const policy = options.policy ?? DEFAULT_UTILITY_POLICY;
  const examples: TrainingExample[] = [];
  const excludedReasons: Record<string, number> = {};
  let excludedCount = 0;

  const exclude = (reason: string) => {
    excludedCount += 1;
    excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
  };

  for (const { observation, event } of records) {
    if (observation.provenance.graderKind === 'defaulted-pass') {
      exclude('duo-defaulted-pass');
      continue;
    }
    if (observation.provenance.configIgnored) {
      exclude('config-ignored');
      continue;
    }
    if (observation.verdict === 'RESISTANT' && observation.provenance.graderKind === 'none') {
      exclude('transport-failure-mislabeled-as-resistance');
      continue;
    }

    const historyBefore = buildHistoryView(allEvents, event.campaignId, event.sequence);
    const budget = options.resolveBudget?.(event.campaignId, event.sequence) ?? NO_BUDGET_TRACKED;
    const features = compileCandidateFeatures({ targetId: observation.targetId, probe: { probeId: observation.probeId }, budget }, historyBefore);
    const label = computeUtilityLabel(policy, observation, historyBefore);

    examples.push({
      campaignId: event.campaignId,
      targetId: observation.targetId,
      probeId: observation.probeId,
      occurredAt: event.occurredAt,
      features,
      label,
    });
  }

  return { examples, excludedCount, excludedReasons };
}
