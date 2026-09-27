import { targetProbeKey } from '../features/history-view.js';
import type { PlannerArm } from './mixer.js';
import type { DispatchLogEntry } from './dispatch.js';

export interface ArmOutcome {
  readonly arm: PlannerArm;
  readonly targetId: string;
  readonly probeId: string;
  readonly label: number;
}

export interface ArmPerformance {
  readonly arm: PlannerArm;
  readonly n: number;
  readonly meanLabel: number;
}

/**
 * Joins dispatch attribution (which arm chose this probe, for which Target) with
 * the actual verified outcome label (Phase 2's computeUtilityLabel), keyed by
 * `targetProbeKey(targetId, probeId)` — a bare-probeId key was a real bug, found
 * by audit: it would conflate two different Targets' outcomes for the same probe,
 * biasing the A/B gate's lift calculation toward whichever target's label
 * happened to be in the map. Probes with no known outcome yet (not executed, or
 * executed but not yet graded) are silently excluded — this is an evaluation over
 * *completed* work only.
 */
export function joinDispatchWithOutcomes(dispatchLog: readonly DispatchLogEntry[], outcomesByTargetProbe: ReadonlyMap<string, number>): ArmOutcome[] {
  const outcomes: ArmOutcome[] = [];
  for (const entry of dispatchLog) {
    const label = outcomesByTargetProbe.get(targetProbeKey(entry.targetId, entry.probeId));
    if (label !== undefined) {
      outcomes.push({ arm: entry.arm, targetId: entry.targetId, probeId: entry.probeId, label });
    }
  }
  return outcomes;
}

export function computeArmPerformance(outcomes: readonly ArmOutcome[]): ArmPerformance[] {
  const byArm = new Map<PlannerArm, number[]>();
  for (const o of outcomes) {
    const bucket = byArm.get(o.arm) ?? [];
    bucket.push(o.label);
    byArm.set(o.arm, bucket);
  }
  return [...byArm.entries()].map(([arm, labels]) => ({
    arm,
    n: labels.length,
    meanLabel: labels.reduce((s, x) => s + x, 0) / labels.length,
  }));
}

export type ABRecommendation = 'PROMOTE' | 'HOLD' | 'DEMOTE';

export interface ABGateOptions {
  readonly minSampleSize: number;
  readonly promoteLiftThreshold: number;
  readonly demoteLiftThreshold: number;
}

export const DEFAULT_AB_GATE_OPTIONS: ABGateOptions = {
  minSampleSize: 20,
  promoteLiftThreshold: 0.05,
  demoteLiftThreshold: -0.05,
};

export interface ABGateResult {
  readonly modelMeanLabel: number | null;
  readonly controlMeanLabel: number | null;
  readonly lift: number | null;
  readonly modelN: number;
  readonly controlN: number;
  readonly sufficientSample: boolean;
  readonly recommendation: ABRecommendation;
}

/**
 * ADAPTIVE_REDTEAM_RUNTIME.md §9.2: EXPERIMENTAL -> CALIBRATED requires "bounded
 * A/B gates pass"; EXPERIMENTAL -> SHADOW on "safety or coverage regression". The
 * control arm is `heuristic` — the deterministic non-model policy, not exploration
 * (exploration is intentionally noisy and not a fair comparison baseline). Without
 * enough samples on both sides this returns HOLD, never a promotion or demotion
 * decision made on thin evidence — "the model cannot promote itself" extends to
 * "the gate does not promote on thin evidence either."
 */
export function evaluateABGate(performance: readonly ArmPerformance[], options: ABGateOptions = DEFAULT_AB_GATE_OPTIONS): ABGateResult {
  const model = performance.find((p) => p.arm === 'model') ?? null;
  const control = performance.find((p) => p.arm === 'heuristic') ?? null;

  const modelN = model?.n ?? 0;
  const controlN = control?.n ?? 0;
  const sufficientSample = modelN >= options.minSampleSize && controlN >= options.minSampleSize;

  if (!sufficientSample || !model || !control) {
    return { modelMeanLabel: model?.meanLabel ?? null, controlMeanLabel: control?.meanLabel ?? null, lift: null, modelN, controlN, sufficientSample, recommendation: 'HOLD' };
  }

  const lift = model.meanLabel - control.meanLabel;
  let recommendation: ABRecommendation = 'HOLD';
  if (lift >= options.promoteLiftThreshold) recommendation = 'PROMOTE';
  else if (lift <= options.demoteLiftThreshold) recommendation = 'DEMOTE';

  return { modelMeanLabel: model.meanLabel, controlMeanLabel: control.meanLabel, lift, modelN, controlN, sufficientSample, recommendation };
}
