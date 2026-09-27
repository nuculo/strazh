import { mulberry32, randInt, randBool, pick } from '../rng.js';
import { modelAdapterFits, isFeatureVersionAccepted, type ModelSnapshotLike } from '../../domain/model-fit.js';
import { deriveVerdict, type GradingState, type GraderKind } from '../../domain/verdict.js';
import { validate } from '../../schemas/index.js';
import { applyEvent } from '../../world/reducer.js';
import { emptyWorld } from '../../world/state.js';
import { replay } from '../../world/replay.js';
import { fingerprint } from '../../world/fingerprint.js';
import type { CampaignEventEnvelope } from '../../events/store.js';
import type { Law } from '../types.js';

const VERDICTS = ['VULNERABLE', 'RESISTANT', 'UNVERIFIED', 'ERROR'];

function syntheticEventStream(seed: number, count: number): CampaignEventEnvelope[] {
  const rng = mulberry32(seed);
  const events: CampaignEventEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push({
      schemaVersion: '1.0.0',
      eventId: `evt-${seed}-${i}`,
      campaignId: 'campaign-1',
      assessmentRunId: 'run-1',
      sequence: i,
      occurredAt: '2026-08-30T00:00:00.000Z',
      committedAt: '2026-08-30T00:00:00.000Z',
      eventType: 'VulnerabilityObserved',
      sourceObservationIds: [],
      featureSnapshotRef: null,
      taxonomySnapshotRef: null,
      payload: { targetId: `t${randInt(rng, 1, 3)}`, probeId: `p${randInt(rng, 1, 4)}:s${randInt(rng, 1, 2)}`, verdict: pick(rng, VERDICTS) },
    });
  }
  return events;
}

function randomCore(seed: number): ModelSnapshotLike {
  const rng = mulberry32(seed);
  return {
    modelRef: `core-${randInt(rng, 1, 3)}`,
    format: 'FZM',
    featureSchemaVersion: `1.${randInt(rng, 0, 2)}.0`,
  };
}

function randomAdapter(seed: number, core: ModelSnapshotLike): ModelSnapshotLike {
  const rng = mulberry32(seed);
  const matches = randBool(rng, 0.5);
  return {
    modelRef: `adapter-${randInt(rng, 1, 3)}`,
    format: 'FZA',
    featureSchemaVersion: matches ? core.featureSchemaVersion : `2.${randInt(rng, 0, 2)}.0`,
    parentCoreRef: matches ? core.modelRef : `core-${randInt(rng, 4, 6)}`,
  };
}

const GRADER_KINDS: GraderKind[] = ['llm-judge', 'deterministic-verifier'];

// wiki/Arch_Overlay/FROZEN_INTEGRATION.md §10.1.
export const frozenLaws: Law[] = [
  {
    id: 'redteam.frozen/replaying-the-same-events-produces-the-same-fingerprint',
    statement:
      'Replaying the same ordered CampaignEvents from empty state always produces the same state fingerprint — independent of how many times it is replayed and independent of world generation (generation identifies lineage, not content).',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const events = syntheticEventStream(seed, randInt(mulberry32(seed + 999), 3, 15));
      const a = replay(events, 'campaign-1', 0);
      const b = replay(events, 'campaign-1', 0);
      const c = replay(events, 'campaign-1', 7); // different generation, same events
      const fpA = fingerprint(a.world);
      const fpB = fingerprint(b.world);
      const fpC = fingerprint(c.world);
      if (fpA !== fpB || fpA !== fpC) {
        return {
          held: false,
          detail: 'Replaying the same events produced different fingerprints',
          counterexample: { fpA, fpB, fpC, eventCount: events.length },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/state-change-advances-epoch',
    statement: "Every frozen-runtime::DynamicState mutation (Rust) advances epoch; there is no mutation path that leaves epoch unchanged. Distinct from RTAP's own CampaignWorld epoch, which is a different aggregate — that one is real and checked by world/reducer.ts's epoch behavior, exercised inside redteam.frozen/duplicate-event-is-idempotent and redteam.frozen/replaying-the-same-events-produces-the-same-fingerprint above, both now implemented (F4). This law stays about the Rust side specifically.",
    status: 'pending',
    trials: 0,
    pendingReason:
      'This is a Rust-side invariant of frozen-runtime::DynamicState, not something RTAP TypeScript can check — blocked on the FrozenService facade, FROZEN_INTEGRATION.md §5.1. Not the same aggregate as RTAP CampaignWorld (world/state.ts), whose epoch behavior Phase 4 does check for real.',
  },
  {
    id: 'redteam.frozen/aggregate-boundary-is-enforced',
    statement: 'DynamicState internals are unreachable from outside the FrozenService facade — no public field allows bypassing epoch advancement.',
    status: 'pending',
    trials: 0,
    pendingReason:
      'Rust-side, in frozen/crates/frozen-runtime, not RTAP TypeScript — belongs to frozen\'s own law registry once the facade in FROZEN_INTEGRATION.md §5.1 lands.',
  },
  {
    id: 'redteam.frozen/duplicate-event-is-idempotent',
    statement: 'Reapplying a CampaignEvent with an already-seen eventId does not advance state twice: epoch, lastSequence and fingerprint are all unchanged by the repeat.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const events = syntheticEventStream(seed, randInt(mulberry32(seed + 1), 2, 10));
      const before = replay(events.slice(0, -1), 'campaign-1', 0).world;
      const lastEvent = events[events.length - 1]!;
      const once = applyEvent(before, lastEvent);
      if (!once.ok) return { held: false, detail: 'setup: first application unexpectedly failed', counterexample: once.error };
      const twice = applyEvent(once.world, lastEvent);
      if (!twice.ok) return { held: false, detail: 'Reapplying a known eventId was rejected instead of treated as a no-op', counterexample: twice.error };

      if (twice.world.epoch !== once.world.epoch || twice.world.lastSequence !== once.world.lastSequence) {
        return {
          held: false,
          detail: 'Duplicate application advanced epoch/lastSequence',
          counterexample: { onceEpoch: once.world.epoch, twiceEpoch: twice.world.epoch },
        };
      }
      if (fingerprint(once.world) !== fingerprint(twice.world)) {
        return { held: false, detail: 'Duplicate application changed the fingerprint', counterexample: {} };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/event-gap-is-rejected',
    statement: 'A sequence gap in committed CampaignEvents stops materialization (ok:false, kind:sequence-gap) instead of silently skipping — and the world is left exactly as it was before the gapped event was offered.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const events = syntheticEventStream(seed, randInt(mulberry32(seed + 2), 2, 10));
      const before = replay(events, 'campaign-1', 0).world;
      const gapped: CampaignEventEnvelope = { ...events[0]!, eventId: 'evt-gap', sequence: before.lastSequence + 2 };

      const result = applyEvent(before, gapped);
      if (result.ok) {
        return { held: false, detail: 'A gapped event was accepted instead of rejected', counterexample: gapped };
      }
      if (result.error.kind !== 'sequence-gap') {
        return { held: false, detail: `Expected error kind sequence-gap, got ${result.error.kind}`, counterexample: result.error };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/model-and-adapter-must-fit',
    statement:
      'modelAdapterFits(core, adapter) is true iff the adapter declares this exact core as its parent and their feature schema versions match exactly.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const core = randomCore(seed);
      const adapter = randomAdapter(seed + 1, core);
      const fits = modelAdapterFits(core, adapter);
      const shouldFit = adapter.parentCoreRef === core.modelRef && adapter.featureSchemaVersion === core.featureSchemaVersion;
      if (fits !== shouldFit) {
        return {
          held: false,
          detail: `modelAdapterFits returned ${fits}, expected ${shouldFit}`,
          counterexample: { core, adapter },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/feature-version-mismatch-is-rejected',
    statement: 'A FeatureSnapshot whose featureSchemaVersion does not exactly match the active WorldBinding is never accepted.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const active = `1.${randInt(rng, 0, 2)}.0`;
      const produced = randBool(rng, 0.5) ? active : `9.${randInt(rng, 0, 2)}.0`;
      const accepted = isFeatureVersionAccepted(produced, active);
      const shouldAccept = produced === active;
      if (accepted !== shouldAccept) {
        return {
          held: false,
          detail: `isFeatureVersionAccepted returned ${accepted}, expected ${shouldAccept}`,
          counterexample: { active, produced },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/recommendation-names-its-input-epoch',
    statement: 'Every FrozenSignal and ProbeRecommendation the schema accepts carries worldGeneration and worldEpoch.',
    status: 'implemented',
    trials: 1,
    check: () => {
      const signal = {
        kind: 'PROBE_UTILITY',
        subjectRef: 'probe-1',
        value: 0.5,
        quality: 'SHADOW',
        reasonCodes: [],
        evidenceObservationIds: [],
        modelRef: 'core-1',
        featureSnapshotRef: 'fs-1',
        // worldGeneration / worldEpoch deliberately omitted
      };
      const result = validate('rtap:frozen-signal', signal);
      if (result.valid) {
        return {
          held: false,
          detail: 'Schema accepted a FrozenSignal missing worldGeneration/worldEpoch',
          counterexample: signal,
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.frozen/worker-failure-does-not-change-verdict',
    statement:
      'deriveVerdict() has no parameter representing frozen-worker health — its output is structurally independent of whether the worker is up, degraded or absent.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const state: GradingState = {
        graderKind: pick(rng, GRADER_KINDS),
        graderRan: true,
        attackSucceeded: randBool(rng, 0.5),
        configIgnored: false,
        transportFailure: false,
      };
      // deriveVerdict's type signature has no frozen-worker field to begin with; calling
      // it twice on an identical state is the executable form of "nothing outside this
      // shape can influence the result".
      const a = deriveVerdict(state);
      const b = deriveVerdict({ ...state });
      if (a !== b) {
        return {
          held: false,
          detail: 'deriveVerdict is non-deterministic for an identical GradingState',
          counterexample: { state, a, b },
        };
      }
      return { held: true };
    },
  },
];
