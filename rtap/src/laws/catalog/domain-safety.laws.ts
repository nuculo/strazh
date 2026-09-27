import { mulberry32, pick, randBool } from '../rng.js';
import { validate } from '../../schemas/index.js';
import { deriveVerdict, wasActuallyGraded, type GradingState, type GraderKind } from '../../domain/verdict.js';
import type { Law } from '../types.js';

const GRADER_KINDS: GraderKind[] = ['llm-judge', 'deterministic-verifier', 'defaulted-pass', 'none'];

function randomGradingState(seed: number): GradingState {
  const rng = mulberry32(seed);
  const graderKind = pick(rng, GRADER_KINDS);
  const graderRan = randBool(rng, 0.7);
  const attackSucceeded = randBool(rng, 0.5) ? randBool(rng, 0.5) : null;
  return {
    graderKind,
    graderRan,
    attackSucceeded,
    configIgnored: randBool(rng, 0.2),
    transportFailure: randBool(rng, 0.1),
  };
}

// wiki/Arch_Overlay/FROZEN_INTEGRATION.md §10.3, ARCHITECTURE.md §8.
export const domainSafetyLaws: Law[] = [
  {
    id: 'redteam.verdict/ungraded-never-becomes-resistant',
    statement:
      'deriveVerdict(state) never returns RESISTANT unless state represents a genuinely and verifiably graded outcome.',
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const state = randomGradingState(seed);
      const verdict = deriveVerdict(state);
      if (verdict === 'RESISTANT' && !wasActuallyGraded(state)) {
        return {
          held: false,
          detail: 'RESISTANT was derived from a state that was not actually graded',
          counterexample: state,
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.observation/unverified-data-is-not-a-positive-label',
    statement:
      'Whenever grading did not produce a real signal (no grader, defaulted-pass, config ignored, null outcome), the verdict is exactly UNVERIFIED — never VULNERABLE and never RESISTANT.',
    status: 'implemented',
    trials: 500,
    check: ({ seed }) => {
      const state = randomGradingState(seed);
      const verdict = deriveVerdict(state);
      const isPositiveOrNegativeLabel = verdict === 'VULNERABLE' || verdict === 'RESISTANT';
      if (!wasActuallyGraded(state) && !state.transportFailure && isPositiveOrNegativeLabel) {
        return {
          held: false,
          detail: `Ungraded state produced ${verdict} instead of UNVERIFIED`,
          counterexample: state,
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.signal/frozen-signal-is-not-a-verdict',
    statement:
      "FrozenSignal.kind and Verdict are disjoint vocabularies — no FrozenSignal kind value can be read as a Verdict value, structurally.",
    status: 'implemented',
    trials: 1,
    check: () => {
      const signalKinds = new Set(
        (ajvEnum('rtap:frozen-signal', '/properties/kind/enum') ?? []) as string[],
      );
      const verdictValues = new Set(
        (ajvEnum('rtap:common', '/$defs/Verdict/enum') ?? []) as string[],
      );
      const overlap = [...signalKinds].filter((k) => verdictValues.has(k));
      if (overlap.length > 0) {
        return {
          held: false,
          detail: `FrozenSignal.kind and Verdict share values: ${overlap.join(', ')}`,
          counterexample: overlap,
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.artifact/raw-payload-never-enters-feature-vector',
    statement:
      'FeatureSnapshot.vector accepts only 60 finite numbers — no schema path exists for raw text/payload bytes to enter a V60.',
    status: 'implemented',
    trials: 20,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const base = validFeatureSnapshotFixture();
      const baseCheck = validate('rtap:feature-snapshot', base);
      if (!baseCheck.valid) {
        // The fixture itself must be valid, or this law would pass for the wrong
        // reason (base already invalid before the tamper) and stop testing anything.
        return { held: false, detail: `Fixture drifted from the schema: ${baseCheck.errors.join('; ')}`, counterexample: base };
      }
      // Mutate one coordinate to a string, as a raw-payload injection would look like.
      const idx = Math.floor(rng() * 60);
      const tampered = { ...base, vector: [...base.vector] };
      (tampered.vector as unknown[])[idx] = 'DROP TABLE users; -- raw payload leaked in';
      const result = validate('rtap:feature-snapshot', tampered);
      if (result.valid) {
        return {
          held: false,
          detail: 'Schema accepted a non-numeric value inside V60',
          counterexample: tampered,
        };
      }
      return { held: true };
    },
  },
];

function ajvEnum(schemaId: string, jsonPointer: string): unknown[] | undefined {
  // Minimal, dependency-free JSON-pointer walk over the already-loaded ajv schema object.
  const schema = getRawSchema(schemaId);
  const parts = jsonPointer.split('/').filter(Boolean);
  let node: unknown = schema;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return Array.isArray(node) ? node : undefined;
}

// Re-import lazily to avoid a hard cycle at module-eval time for the ajv instance.
import { ajv } from '../../schemas/index.js';
function getRawSchema(id: string): unknown {
  return ajv.getSchema(id)?.schema;
}

function validFeatureSnapshotFixture() {
  return {
    featureSchemaVersion: '1.0.0',
    normalizationVersion: 'norm-1',
    taxonomyVersion: 'tax-1',
    compilerBuild: 'fc-v1',
    featureView: 'OBSERVATION',
    sourceObservationId: 'obs-1',
    candidateProbeId: null,
    candidateTargetId: null,
    vector: Array.from({ length: 60 }, (_, i) => i / 60),
  };
}
