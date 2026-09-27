import type { TrainingExample } from './dataset-exporter.js';
import { vulnerabilityClassOf } from '../features/history-view.js';

export interface SplitResult {
  readonly train: TrainingExample[];
  readonly holdout: TrainingExample[];
}

/**
 * FROZEN_INTEGRATION.md §8.2: "Random row split is forbidden." Every split here
 * groups by an identity (target, campaign, vulnerability class) or by time, and puts
 * a whole group on one side — never split within a group, or the holdout leaks
 * through campaign history features that summarize "what happened to this target/
 * probe class before".
 */
export function splitByTarget(examples: readonly TrainingExample[], holdoutTargetIds: ReadonlySet<string>): SplitResult {
  return partition(examples, (e) => holdoutTargetIds.has(e.targetId));
}

export function splitByCampaign(examples: readonly TrainingExample[], holdoutCampaignIds: ReadonlySet<string>): SplitResult {
  return partition(examples, (e) => holdoutCampaignIds.has(e.campaignId));
}

/** Holdout = everything at or after `cutoffIso` — the "temporal future" holdout. */
export function splitByTime(examples: readonly TrainingExample[], cutoffIso: string): SplitResult {
  return partition(examples, (e) => e.occurredAt >= cutoffIso);
}

/** "Domain transfer" proxy: hold out entire vulnerability classes, not just probes. */
export function splitByVulnerabilityClass(examples: readonly TrainingExample[], holdoutClasses: ReadonlySet<string>): SplitResult {
  return partition(examples, (e) => holdoutClasses.has(vulnerabilityClassOf(e.probeId)));
}

function partition(examples: readonly TrainingExample[], isHoldout: (e: TrainingExample) => boolean): SplitResult {
  const train: TrainingExample[] = [];
  const holdout: TrainingExample[] = [];
  for (const e of examples) (isHoldout(e) ? holdout : train).push(e);
  return { train, holdout };
}

export interface LeakageCheck {
  readonly clean: boolean;
  readonly overlapping: string[];
}

/** Verifies no identity from `groupOf` appears on both sides of a split. */
export function checkNoLeakage(split: SplitResult, groupOf: (e: TrainingExample) => string): LeakageCheck {
  const trainGroups = new Set(split.train.map(groupOf));
  const holdoutGroups = new Set(split.holdout.map(groupOf));
  const overlapping = [...trainGroups].filter((g) => holdoutGroups.has(g));
  return { clean: overlapping.length === 0, overlapping };
}
