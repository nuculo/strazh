import { describe, expect, it } from 'vitest';
import { validate } from '../../src/schemas/index.js';
import { computeTargetDrift, DEFAULT_DRIFT_THRESHOLD } from '../../src/shadow/target-drift.js';
import { buildHistoryView } from '../../src/features/history-view.js';
import type { ObservationForFeatures } from '../../src/features/observation-compiler.js';

const history = buildHistoryView([], 'campaign-1', 0);
const world = { worldGeneration: 0, worldEpoch: 10 };

function obs(id: string, verdict: string, graderKind = 'llm-judge'): ObservationForFeatures & { id: string } {
  return { id, targetId: 'target-1', probeId: 'prompt-injection:base64', verdict, provenance: { engineId: 'promptfoo', graderKind, configIgnored: false } };
}

describe('computeTargetDrift', () => {
  it('reports insufficient-data when either window is empty', () => {
    const signal = computeTargetDrift('target-1', [], [obs('r1', 'RESISTANT')], history, world);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes).toEqual(['insufficient-data']);
  });

  it('is zero distance for two windows with the exact same observations', () => {
    const set = [obs('c1', 'RESISTANT'), obs('c2', 'RESISTANT')];
    const signal = computeTargetDrift('target-1', set, set, history, world);
    expect(signal.value).toBe(0);
  });

  it('reports a real positive distance when the verdict distribution genuinely shifts', () => {
    const reference = [obs('r1', 'RESISTANT'), obs('r2', 'RESISTANT'), obs('r3', 'RESISTANT')];
    const current = [obs('c1', 'VULNERABLE'), obs('c2', 'VULNERABLE'), obs('c3', 'VULNERABLE')];
    const signal = computeTargetDrift('target-1', current, reference, history, world);
    expect(signal.value).toBeGreaterThan(0);
    expect(signal.kind).toBe('TARGET_DRIFT');
    expect(signal.targetId).toBe('target-1');
  });

  it('flags drift-exceeds-threshold in reasonCodes exactly when the distance crosses the threshold', () => {
    const reference = [obs('r1', 'RESISTANT')];
    const current = [obs('c1', 'VULNERABLE')];
    const signal = computeTargetDrift('target-1', current, reference, history, world, 'SHADOW', 0.01);
    expect(signal.value).toBeGreaterThan(0.01);
    expect(signal.reasonCodes[0]).toBe(`drift-exceeds-threshold:0.01`);
  });

  it('reports drift-within-threshold when the distance does not cross a generous threshold', () => {
    const reference = [obs('r1', 'RESISTANT')];
    const current = [obs('c1', 'RESISTANT')];
    const signal = computeTargetDrift('target-1', current, reference, history, world, 'SHADOW', DEFAULT_DRIFT_THRESHOLD);
    expect(signal.reasonCodes[0]).toBe(`drift-within-threshold:${DEFAULT_DRIFT_THRESHOLD}`);
  });

  it('carries every contributing observation id as evidence', () => {
    const reference = [obs('r1', 'RESISTANT')];
    const current = [obs('c1', 'VULNERABLE'), obs('c2', 'VULNERABLE')];
    const signal = computeTargetDrift('target-1', current, reference, history, world);
    expect(signal.evidenceObservationIds.sort()).toEqual(['c1', 'c2', 'r1']);
  });

  it('produces a schema-valid FrozenSignal', () => {
    const signal = computeTargetDrift('target-1', [obs('c1', 'VULNERABLE')], [obs('r1', 'RESISTANT')], history, world);
    const check = validate('rtap:frozen-signal', signal);
    expect(check.valid, check.errors.join('; ')).toBe(true);
  });
});
