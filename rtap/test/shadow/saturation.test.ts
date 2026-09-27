import { describe, expect, it } from 'vitest';
import { validate } from '../../src/schemas/index.js';
import { computeSaturation } from '../../src/shadow/saturation.js';
import { emptyWorld } from '../../src/world/state.js';
import type { CampaignWorldState, RelationRecord } from '../../src/world/state.js';

function relation(sourceId: string, targetId: string, sequence: number): RelationRecord {
  return { type: 'PROBE_TESTS_TARGET', sourceId, targetId, confidence: 1, sequence };
}

function worldWithRelations(relations: RelationRecord[], lastSequence: number): CampaignWorldState {
  return { ...emptyWorld('campaign-1'), relations, lastSequence };
}

describe('computeSaturation', () => {
  it('reports insufficient-history when fewer than two full windows of events exist', () => {
    const world = worldWithRelations([], 5); // 6 events, windowSize default 5 needs 10
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes).toEqual(['insufficient-history']);
  });

  it('reports a high saturation value when the recent window has far fewer new relations than the previous one', () => {
    const relations = [
      ...Array.from({ length: 5 }, (_, i) => relation(`probe-${i}`, 'target-1', i)), // previous window [0,5): 5 new
      // recent window [5,10): 0 new
    ];
    const world = worldWithRelations(relations, 9); // 10 events total
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.value).toBe(1); // recentRate 0, previousRate 1 -> saturation 1
    expect(signal.kind).toBe('SATURATION');
    expect(signal.targetId).toBe('target-1');
    expect(signal.reasonCodes).toEqual(['previous-window-new-relations:5', 'recent-window-new-relations:0']);
  });

  it('clamps to 0 (never negative) when the recent window learns more than the previous one', () => {
    const relations = [
      relation('probe-0', 'target-1', 0), // previous window: 1 new
      ...Array.from({ length: 5 }, (_, i) => relation(`probe-${i + 1}`, 'target-1', 5 + i)), // recent window: 5 new
    ];
    const world = worldWithRelations(relations, 9);
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.value).toBe(0);
  });

  it('reports no-baseline-rate-to-compare-against when the previous window had nothing but the recent one does', () => {
    const relations = Array.from({ length: 3 }, (_, i) => relation(`probe-${i}`, 'target-1', 5 + i));
    const world = worldWithRelations(relations, 9);
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.value).toBe(0);
    expect(signal.reasonCodes).toEqual(['no-baseline-rate-to-compare-against']);
  });

  it('reports no-new-information-in-either-window when nothing was ever learned about this target', () => {
    const world = worldWithRelations([], 9);
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.reasonCodes).toEqual(['no-new-information-in-either-window']);
  });

  it('ignores relations about a different target entirely', () => {
    const relations = Array.from({ length: 5 }, (_, i) => relation(`probe-${i}`, 'target-OTHER', i));
    const world = worldWithRelations(relations, 9);
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.reasonCodes).toEqual(['no-new-information-in-either-window']);
  });

  it('counts a relation where the target is the source, not just the destination', () => {
    // TARGET_EXPOSES_FINDING: sourceId = targetId, targetId = findingId — the target is the *source* here.
    const relations: RelationRecord[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'TARGET_EXPOSES_FINDING' as const, sourceId: 'target-1', targetId: `finding-${i}`, confidence: 1, sequence: i })),
    ];
    const world = worldWithRelations(relations, 9);
    const signal = computeSaturation(world, 'target-1', 5);
    expect(signal.reasonCodes).toEqual(['previous-window-new-relations:5', 'recent-window-new-relations:0']);
  });

  it('produces a schema-valid FrozenSignal', () => {
    const world = worldWithRelations([relation('p1', 'target-1', 0)], 9);
    const signal = computeSaturation(world, 'target-1', 5);
    const check = validate('rtap:frozen-signal', signal);
    expect(check.valid, check.errors.join('; ')).toBe(true);
  });
});
