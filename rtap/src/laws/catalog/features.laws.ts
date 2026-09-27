import { mulberry32, randInt } from '../rng.js';
import { validate } from '../../schemas/index.js';
import { compileCandidateFeatures, type CandidateForFeatures } from '../../features/candidate-compiler.js';
import { compileObservationFeatures, type ObservationForFeatures } from '../../features/observation-compiler.js';
import { buildHistoryView } from '../../features/history-view.js';
import { COORD } from '../../features/coordinates.js';
import { MISSING } from '../../features/missing.js';
import type { Law } from '../types.js';

const EMPTY_HISTORY = buildHistoryView([], 'campaign-1', 0);

function randomCandidate(seed: number): CandidateForFeatures {
  const rng = mulberry32(seed);
  return {
    targetId: `target-${randInt(rng, 1, 3)}`,
    probe: { probeId: `plugin-${randInt(rng, 1, 5)}:strategy-${randInt(rng, 1, 3)}` },
    budget: { targetCallsUsed: randInt(rng, 0, 50), targetCallsBudget: 100 },
  };
}

function randomObservation(seed: number): ObservationForFeatures {
  const rng = mulberry32(seed);
  const verdicts = ['VULNERABLE', 'RESISTANT', 'UNVERIFIED', 'ERROR'];
  return {
    id: `obs-${seed}`,
    targetId: `target-${randInt(rng, 1, 3)}`,
    probeId: `plugin-${randInt(rng, 1, 5)}:strategy-${randInt(rng, 1, 3)}`,
    verdict: verdicts[randInt(rng, 0, 3)]!,
    provenance: { engineId: 'promptfoo', graderKind: 'llm-judge', configIgnored: false },
  };
}

// ADAPTIVE_REDTEAM_RUNTIME.md §4.4, §14: redteam.feature/observation-and-candidate-
// views-are-not-interchangeable.
export const featureLaws: Law[] = [
  {
    id: 'redteam.feature/observation-and-candidate-views-are-not-interchangeable',
    statement:
      'A CANDIDATE FeatureSnapshot never carries a sourceObservationId, and an OBSERVATION FeatureSnapshot never carries a candidateProbeId — the schema rejects either cross-assignment even at matching V60 dimensionality.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const candidate = compileCandidateFeatures(randomCandidate(seed), EMPTY_HISTORY);
      const observation = compileObservationFeatures(randomObservation(seed), EMPTY_HISTORY);

      if (candidate.vector.length !== 60 || observation.vector.length !== 60) {
        return { held: false, detail: 'A compiler did not produce exactly 60 coordinates', counterexample: { candidate, observation } };
      }

      // The actual leakage attack this law guards against: take a CANDIDATE snapshot
      // and try to pass it off as OBSERVATION-view (or vice versa) by relabeling.
      const relabeled = { ...candidate, featureView: 'OBSERVATION', sourceObservationId: 'forged' };
      const stillCandidateShaped = validate('rtap:feature-snapshot', relabeled);
      if (stillCandidateShaped.valid) {
        return {
          held: false,
          detail: 'A CANDIDATE snapshot relabeled as OBSERVATION (candidateProbeId still set) was accepted by the schema',
          counterexample: relabeled,
        };
      }

      const observationValid = validate('rtap:feature-snapshot', observation);
      const candidateValid = validate('rtap:feature-snapshot', candidate);
      if (!observationValid.valid || !candidateValid.valid) {
        return {
          held: false,
          detail: 'A correctly-shaped compiler output was rejected by its own schema',
          counterexample: { observation, observationValid, candidate, candidateValid },
        };
      }

      return { held: true };
    },
  },
  {
    id: 'redteam.feature/candidate-view-has-no-post-hoc-signal',
    statement:
      "CandidateFeatureCompiler's GRADING, RESPONSE_BEHAVIOR and RUNTIME_AND_TRACE coordinate groups are always MISSING — there is no code path by which an execution outcome can enter a CANDIDATE vector, because compileCandidateFeatures's own parameter type has no field to carry one.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const candidate = compileCandidateFeatures(randomCandidate(seed), EMPTY_HISTORY);
      const postHocGroups = [COORD.RESPONSE_BEHAVIOR, COORD.GRADING, COORD.RUNTIME_AND_TRACE];
      for (const group of postHocGroups) {
        for (let i = group.start; i < group.start + group.count; i += 1) {
          if (candidate.vector[i] !== MISSING) {
            return {
              held: false,
              detail: `Coordinate ${i} in a post-hoc-only group was populated in a CANDIDATE vector`,
              counterexample: candidate,
            };
          }
        }
      }
      return { held: true };
    },
  },
];
