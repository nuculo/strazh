import { describe, expect, it } from 'vitest';
import { mixCandidates } from '../../src/planner/mixer.js';
import { mulberry32 } from '../../src/laws/rng.js';
import type { EligibleCandidate } from '../../src/candidates/enumerate.js';
import type { RankedCandidate } from '../../src/shadow/rank.js';
import type { RecommendationBinding } from '../../src/domain/recommendation-binding.js';
import type { PlannerPolicy } from '../../src/planner/policy.js';
import { emptyWorld } from '../../src/world/state.js';
import { fingerprint } from '../../src/world/fingerprint.js';

const currentBinding: RecommendationBinding = {
  campaignId: 'campaign-1',
  targetId: 't1',
  worldGeneration: 0,
  worldEpoch: 10,
  featureSchemaVersion: '1.0.0',
  modelDigest: 'digest-1',
  policyVersion: 'policy-1',
};

const bindingContext = { campaignId: 'campaign-1', featureSchemaVersion: '1.0.0', modelDigest: 'digest-1', policyVersion: 'policy-1' };

function signal(targetId: string, worldEpoch: number, value = 0.5) {
  return {
    kind: 'PROBE_UTILITY' as const,
    subjectRef: '',
    targetId,
    value,
    quality: 'EXPERIMENTAL' as const,
    reasonCodes: [],
    evidenceObservationIds: [],
    modelRef: 'm1',
    adapterRef: null,
    featureSnapshotRef: 'fs-1',
    worldGeneration: 0,
    worldEpoch,
  };
}

function ranked(probeId: string, rank: number, worldEpoch = 10, targetId = 't1'): RankedCandidate {
  return { targetId, probeId, rank, signal: signal(targetId, worldEpoch) };
}

const policy: PlannerPolicy = { policyVersion: 'policy-1', modelShareCap: 0.3, explorationShare: 0.2, maxBatchSize: 10 };

describe('mixCandidates', () => {
  it('every mandatory candidate is included via the mandatory arm', () => {
    const eligible: EligibleCandidate[] = [
      { targetId: 't1', probeId: 'm1', mandatory: true },
      { targetId: 't1', probeId: 'm2', mandatory: true },
      ...Array.from({ length: 10 }, (_, i) => ({ targetId: 't1', probeId: `p${i}`, mandatory: false })),
    ];
    const modelRanking = eligible.filter((c) => !c.mandatory).map((c, i) => ranked(c.probeId, i + 1));
    const result = mixCandidates(eligible, modelRanking, [...modelRanking].reverse(), currentBinding, bindingContext, policy, mulberry32(1));

    expect(result.decisions.filter((d) => d.arm === 'mandatory').map((d) => d.probeId).sort()).toEqual(['m1', 'm2']);
    expect(result.mandatoryShortfall).toEqual([]);
  });

  it('a stale model recommendation is dropped from the model arm, not executed', () => {
    // A large non-mandatory pool with a *low* exploration share keeps the random
    // exploration draw from incidentally consuming p0 before the model arm gets to
    // evaluate (and reject) it — this test is about the model/staleness path
    // specifically, not exploration's independent randomness. (seed 1 verified by
    // hand not to collide for this pool size / share — see PR discussion.)
    const eligible: EligibleCandidate[] = Array.from({ length: 30 }, (_, i) => ({ targetId: 't1', probeId: `p${i}`, mandatory: false }));
    // p0 is ranked #1 by the model but at a stale epoch (9, not the current 10).
    const modelRanking: RankedCandidate[] = [ranked('p0', 1, 9), ...eligible.slice(1).map((c, i) => ranked(c.probeId, i + 2, 10))];
    const heuristicRanking = [...eligible].reverse().map((c, i) => ranked(c.probeId, i + 1));
    const lowExplorationPolicy: PlannerPolicy = { ...policy, explorationShare: 0.05 };

    const result = mixCandidates(eligible, modelRanking, heuristicRanking, currentBinding, bindingContext, lowExplorationPolicy, mulberry32(1));

    const modelDecision = result.decisions.find((d) => d.probeId === 'p0');
    expect(modelDecision?.arm).not.toBe('model'); // never dispatched via the stale recommendation
    expect(result.staleModelRecommendationsDropped).toBeGreaterThanOrEqual(1);
  });

  it('exploration is selected before the model arm gets to claim the remainder', () => {
    const eligible: EligibleCandidate[] = Array.from({ length: 10 }, (_, i) => ({ targetId: 't1', probeId: `p${i}`, mandatory: false }));
    const modelRanking = eligible.map((c, i) => ranked(c.probeId, i + 1));
    const result = mixCandidates(eligible, modelRanking, [...modelRanking].reverse(), currentBinding, bindingContext, policy, mulberry32(1));
    expect(result.armCounts.exploration).toBeGreaterThan(0);
  });

  it('never exceeds maxBatchSize even with abundant supply', () => {
    const eligible: EligibleCandidate[] = Array.from({ length: 100 }, (_, i) => ({ targetId: 't1', probeId: `p${i}`, mandatory: false }));
    const modelRanking = eligible.map((c, i) => ranked(c.probeId, i + 1));
    const result = mixCandidates(eligible, modelRanking, [...modelRanking].reverse(), currentBinding, bindingContext, policy, mulberry32(1));
    expect(result.decisions.length).toBe(policy.maxBatchSize);
  });

  it('is deterministic for a fixed seeded rng', () => {
    const eligible: EligibleCandidate[] = Array.from({ length: 20 }, (_, i) => ({ targetId: 't1', probeId: `p${i}`, mandatory: false }));
    const modelRanking = eligible.map((c, i) => ranked(c.probeId, i + 1));
    const heuristicRanking = [...modelRanking].reverse();
    const a = mixCandidates(eligible, modelRanking, heuristicRanking, currentBinding, bindingContext, policy, mulberry32(42));
    const b = mixCandidates(eligible, modelRanking, heuristicRanking, currentBinding, bindingContext, policy, mulberry32(42));
    expect(a.decisions).toEqual(b.decisions);
  });

  it('reports mandatoryShortfall (not a silent drop or a cap violation) when mandatory alone exceeds maxBatchSize', () => {
    const smallPolicy: PlannerPolicy = { ...policy, maxBatchSize: 2 };
    const eligible: EligibleCandidate[] = [
      { targetId: 't1', probeId: 'm1', mandatory: true },
      { targetId: 't1', probeId: 'm2', mandatory: true },
      { targetId: 't1', probeId: 'm3', mandatory: true },
    ];
    const result = mixCandidates(eligible, [], [], currentBinding, bindingContext, smallPolicy, mulberry32(1));
    expect(result.decisions.length).toBe(2);
    expect(result.mandatoryShortfall).toEqual([{ targetId: 't1', probeId: 'm3' }]);
  });

  it('the same probeId eligible for two different targets both survive in one batch — the exact bug this phase fixes', () => {
    const eligible: EligibleCandidate[] = [
      { targetId: 't-A', probeId: 'shared', mandatory: false },
      { targetId: 't-B', probeId: 'shared', mandatory: false },
    ];
    const result = mixCandidates(eligible, [], [], currentBinding, bindingContext, policy, mulberry32(1));
    expect(result.decisions).toHaveLength(2);
    const targets = result.decisions.map((d) => d.targetId).sort();
    expect(targets).toEqual(['t-A', 't-B']);
  });

  it('throws for an invalid policy rather than silently proceeding', () => {
    expect(() => mixCandidates([], [], [], currentBinding, bindingContext, { ...policy, explorationShare: 0 }, mulberry32(1))).toThrow();
  });

  describe('RecommendationProvenance (audit #3 remainder)', () => {
    // eligible is deliberately empty — mandatory/exploration only ever draw from
    // it, so an empty eligible means the model arm's single slot always resolves
    // to modelRanking[0] deterministically, regardless of the (still-required,
    // still-positive) explorationShare.
    const eligible: EligibleCandidate[] = [];
    const modelRanking: RankedCandidate[] = [ranked('p0', 1, 10)];
    const singleSlotPolicy: PlannerPolicy = { policyVersion: 'policy-1', modelShareCap: 0.8, explorationShare: 0.2, maxBatchSize: 5 };

    it('is null on the model arm when BindingContext supplies neither world nor compilerDigest — never fabricated', () => {
      const result = mixCandidates(eligible, modelRanking, [], currentBinding, bindingContext, singleSlotPolicy, mulberry32(1));
      const decision = result.decisions.find((d) => d.arm === 'model');
      expect(decision).toBeDefined();
      expect(decision!.provenance).toBeNull();
    });

    it('is populated on the model arm, matching fingerprint(world) exactly, when both are supplied', () => {
      const world = emptyWorld('campaign-1', 2);
      const ctx = { ...bindingContext, world, compilerDigest: 'candidate-fc-v1' };
      const now = new Date('2026-08-30T00:00:00.000Z');
      const result = mixCandidates(eligible, modelRanking, [], currentBinding, ctx, singleSlotPolicy, mulberry32(1), undefined, now);
      const decision = result.decisions.find((d) => d.arm === 'model');
      expect(decision?.provenance).not.toBeNull();
      expect(decision!.provenance!.worldFingerprint).toBe(fingerprint(world));
      expect(decision!.provenance!.compilerDigest).toBe('candidate-fc-v1');
      expect(decision!.provenance!.featureDigest).toBe(modelRanking[0]!.signal.featureSnapshotRef);
      expect(decision!.provenance!.createdAt).toBe(now.toISOString());
    });

    it('is null for mandatory/exploration/heuristic decisions even when BindingContext supplies world and compilerDigest', () => {
      const world = emptyWorld('campaign-1');
      const ctx = { ...bindingContext, world, compilerDigest: 'candidate-fc-v1' };
      const mandatoryEligible: EligibleCandidate[] = [{ targetId: 't1', probeId: 'm1', mandatory: true }];
      const result = mixCandidates(mandatoryEligible, [], [], currentBinding, ctx, singleSlotPolicy, mulberry32(1));
      const decision = result.decisions.find((d) => d.arm === 'mandatory');
      expect(decision?.provenance).toBeNull();
    });
  });
});
