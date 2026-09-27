import { mulberry32, randInt, randBool, pick } from '../rng.js';
import { computeSaturation } from '../../shadow/saturation.js';
import { computeTargetDrift } from '../../shadow/target-drift.js';
import { computeRiskTrend, type RiskTrendObservation } from '../../shadow/risk-trend.js';
import { computeGraderDisagreement, type GradedObservation } from '../../pipeline/grader-disagreement.js';
import { buildHistoryView } from '../../features/history-view.js';
import type { ObservationForFeatures } from '../../features/observation-compiler.js';
import { emptyWorld } from '../../world/state.js';
import type { CampaignWorldState, RelationRecord } from '../../world/state.js';
import type { Law } from '../types.js';

// FROZEN_INTEGRATION.md §5.4 — the five F5 signal kinds this repo can build
// without a second trained model. PROBE_UTILITY's own laws already live in
// shadow.laws.ts/planner.laws.ts; RETEST_PRIORITY has no producer yet (blocked on
// episodic memory, see rtap/README.md's Phase 5 section) and so has no law here.

const emptyHistory = buildHistoryView([], 'campaign-1', 0);
const WORLD_POSITION = { worldGeneration: 0, worldEpoch: 10 };

function randomWorldWithRelations(rng: () => number, targetId: string, windowSize: number): { world: CampaignWorldState; previousCount: number; recentCount: number } {
  const previousCount = randInt(rng, 0, windowSize);
  const recentCount = randInt(rng, 0, windowSize);
  const relations: RelationRecord[] = [
    ...Array.from({ length: previousCount }, (_, i) => ({ type: 'PROBE_TESTS_TARGET' as const, sourceId: `probe-prev-${i}`, targetId, confidence: 1, sequence: i })),
    ...Array.from({ length: recentCount }, (_, i) => ({ type: 'PROBE_TESTS_TARGET' as const, sourceId: `probe-recent-${i}`, targetId, confidence: 1, sequence: windowSize + i })),
  ];
  const world: CampaignWorldState = { ...emptyWorld('campaign-1'), relations, lastSequence: windowSize * 2 - 1 };
  return { world, previousCount, recentCount };
}

function randomObservation(rng: () => number, id: string, verdict: string): ObservationForFeatures & { id: string } {
  return {
    id,
    targetId: 'target-1',
    probeId: `${pick(rng, ['prompt-injection', 'harmful-cybercrime', 'pii-leak'])}:${pick(rng, ['base64', 'default'])}`,
    verdict,
    provenance: { engineId: pick(rng, ['promptfoo', 'duo-static', 'duo-llm']), graderKind: 'llm-judge', configIgnored: false },
  };
}

export const campaignSignalLaws: Law[] = [
  {
    id: 'redteam.signal/saturation-value-is-bounded-and-tracks-the-windowed-rate',
    statement:
      "computeSaturation() always returns a value in [0, 1]. Given a full two-window history, value is 0 whenever the previous window's new-relation count is 0 (nothing to compare against — never a fabricated 1.0), and is otherwise exactly clamp(1 - recentRate/previousRate, 0, 1), recomputed independently here as an oracle rather than by calling the function's own formula a second time.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const windowSize = randInt(rng, 2, 8);
      const { world, previousCount, recentCount } = randomWorldWithRelations(rng, 'target-1', windowSize);
      const signal = computeSaturation(world, 'target-1', windowSize);

      if (signal.value < 0 || signal.value > 1) {
        return { held: false, detail: 'value escaped [0, 1]', counterexample: { signal, previousCount, recentCount } };
      }
      if (previousCount === 0) {
        if (signal.value !== 0) {
          return { held: false, detail: 'a zero previous-window count did not produce value 0', counterexample: { signal, previousCount, recentCount } };
        }
        return { held: true };
      }
      const expected = Math.max(0, Math.min(1, 1 - recentCount / windowSize / (previousCount / windowSize)));
      if (Math.abs(signal.value - expected) > 1e-9) {
        return { held: false, detail: 'value did not match the independently-recomputed windowed rate', counterexample: { signal, expected, previousCount, recentCount, windowSize } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signal/target-drift-is-symmetric-and-zero-for-identical-windows',
    statement:
      'computeTargetDrift() is a real (Euclidean) distance: swapping which observation set is "current" and which is "reference" never changes the reported value, and two windows built from the exact same observations always report a distance of exactly 0.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const countA = randInt(rng, 1, 5);
      const countB = randInt(rng, 1, 5);
      const verdicts = ['VULNERABLE', 'RESISTANT', 'UNVERIFIED'];
      const setA = Array.from({ length: countA }, (_, i) => randomObservation(rng, `a-${i}`, pick(rng, verdicts)));
      const setB = Array.from({ length: countB }, (_, i) => randomObservation(rng, `b-${i}`, pick(rng, verdicts)));

      const forward = computeTargetDrift('target-1', setA, setB, emptyHistory, WORLD_POSITION);
      const backward = computeTargetDrift('target-1', setB, setA, emptyHistory, WORLD_POSITION);
      if (Math.abs(forward.value - backward.value) > 1e-9) {
        return { held: false, detail: 'swapping current/reference changed the reported distance', counterexample: { forward: forward.value, backward: backward.value, setA, setB } };
      }

      const selfDistance = computeTargetDrift('target-1', setA, setA, emptyHistory, WORLD_POSITION);
      if (selfDistance.value !== 0) {
        return { held: false, detail: 'identical current/reference windows did not report zero distance', counterexample: { selfDistance, setA } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signal/risk-trend-direction-matches-its-own-sign',
    statement:
      "computeRiskTrend()'s reasonCodes[0] ('risk-increasing'/'risk-decreasing'/'risk-stable') always agrees with the sign of its own value, and the value always equals exactly (recent-window mean - earlier-window mean) for the two equal-size consecutive windows the points split into — recomputed independently here, not by calling the function's own arithmetic twice.",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const count = randInt(rng, 2, 20);
      const points: RiskTrendObservation[] = Array.from({ length: count }, (_, i) => ({
        id: `o${i}`,
        occurredAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        nativeMetrics: [{ namespace: 'duo' as const, name: 'severity', value: randInt(rng, 0, 100) }],
      }));

      const signal = computeRiskTrend('target-1', points, 'duo', 'severity', WORLD_POSITION);

      const windowSize = Math.max(1, Math.floor(count / 2));
      const values = points.map((p) => p.nativeMetrics![0]!.value);
      const earlier = values.slice(0, windowSize);
      const recent = values.slice(values.length - windowSize);
      const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const expected = avg(recent) - avg(earlier);

      if (Math.abs(signal.value - expected) > 1e-9) {
        return { held: false, detail: 'value did not match the independently-recomputed windowed mean difference', counterexample: { signal, expected } };
      }
      const direction = signal.reasonCodes[0];
      const expectedDirection = expected > 0 ? 'risk-increasing' : expected < 0 ? 'risk-decreasing' : 'risk-stable';
      if (direction !== expectedDirection) {
        return { held: false, detail: 'reasonCodes[0] direction did not match the sign of value', counterexample: { signal, expected, expectedDirection } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signal/grader-disagreement-is-zero-iff-graded-engines-agree',
    statement:
      'computeGraderDisagreement() reports exactly 0 whenever every graded (non-UNVERIFIED, grader-ran) observation from at least two distinct engines shares the same verdict, and a strictly positive value whenever at least two distinct verdicts appear among them — never the reverse in either direction — and the value always equals exactly 1 - (the most common verdict\'s share of graded observations), recomputed independently here.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const count = randInt(rng, 2, 10);
      const engines = ['promptfoo', 'duo-static', 'duo-llm'];
      const verdicts = ['VULNERABLE', 'RESISTANT'];
      const observations: GradedObservation[] = Array.from({ length: count }, (_, i) => ({
        id: `o${i}`,
        verdict: randBool(rng, 0.15) ? 'UNVERIFIED' : pick(rng, verdicts),
        engineId: pick(rng, engines),
        graderRan: !randBool(rng, 0.1),
      }));

      const signal = computeGraderDisagreement('target-1', 'probe-1', observations, WORLD_POSITION);

      const graded = observations.filter((o) => o.graderRan && o.verdict !== 'UNVERIFIED');
      const distinctEngines = new Set(graded.map((o) => o.engineId));
      if (distinctEngines.size < 2) {
        if (signal.value !== 0) {
          return { held: false, detail: 'fewer than two distinct graded engines still produced a nonzero disagreement score', counterexample: { signal, graded } };
        }
        return { held: true };
      }

      const counts = new Map<string, number>();
      for (const o of graded) counts.set(o.verdict, (counts.get(o.verdict) ?? 0) + 1);
      const maxCount = Math.max(...counts.values());
      const expected = 1 - maxCount / graded.length;
      const unanimous = counts.size === 1;

      if (unanimous !== (signal.value === 0)) {
        return { held: false, detail: 'unanimity among distinct graders did not correspond exactly to a zero disagreement score', counterexample: { signal, counts: [...counts.entries()], unanimous } };
      }
      if (Math.abs(signal.value - expected) > 1e-9) {
        return { held: false, detail: 'value did not match the independently-recomputed disagreement fraction', counterexample: { signal, expected, counts: [...counts.entries()] } };
      }
      return { held: true };
    },
  },
];
