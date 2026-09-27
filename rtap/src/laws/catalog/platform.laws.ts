import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, randInt, randBool, pick } from '../rng.js';
import { validate } from '../../schemas/index.js';
import { groupNativeMetricsByNamespace, type NativeMetric } from '../../domain/native-metrics.js';
import { replay } from '../../world/replay.js';
import { fingerprint } from '../../world/fingerprint.js';
import { CampaignWorldMaterializer } from '../../world/materializer.js';
import { checkCapabilities, type EngineAdapterCapabilities, type EngineAdapterCapability } from '../../adapters/capability.js';
import { DuoLlmCliAdapter, DECLARED_CAPABILITIES, REQUIRED_CAPABILITIES } from '../../adapters/duo-llm/run.js';
import { applyMigrations, listAppliedMigrations, type Migration } from '../../db/migrations.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { DatabaseSync } from 'node:sqlite';
import { CampaignEventStore, type CampaignEventEnvelope, type CampaignEventInput } from '../../events/store.js';
import { OutboxStore } from '../../events/outbox.js';
import { buildAssessmentReport, buildJsonReport, buildMarkdownReport } from '../../pipeline/report.js';
import { buildSarifReport } from '../../pipeline/sarif.js';
import { correlateFindings, type ObservationLike } from '../../pipeline/correlate.js';
import type { ArtifactRef } from '../../artifacts/store.js';
import { RunStepStore } from '../../runsteps/store.js';
import { ExecutionAttemptStore } from '../../execution/execution-attempt-store.js';
import type { TerminalReason } from '../../execution/types.js';
import { buildHistoryView, buildSettledAttemptsByReason, targetProbeKey } from '../../features/history-view.js';
import { enumerateEligibleCandidates, blocksEligibility } from '../../candidates/enumerate.js';
import type { ProbeCatalogEntry } from '../../candidates/catalog.js';
import { AssessmentRunStore, AssessmentRunCampaignMismatchError, type IntelligenceStatus } from '../../planner/assessment-run-store.js';
import { rankCandidates } from '../../shadow/rank.js';
import { compileCandidateFeatures } from '../../features/candidate-compiler.js';
import type { Law } from '../types.js';

const ALL_ENGINE_ADAPTER_CAPABILITIES: EngineAdapterCapability[] = ['realTargetProvider', 'strategiesConnected', 'mandatoryGrading', 'deterministicScoring'];

const REPLAY_VERDICTS = ['VULNERABLE', 'RESISTANT', 'UNVERIFIED', 'ERROR'];

function syntheticEventStreamForReplay(seed: number, count: number): CampaignEventEnvelope[] {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    schemaVersion: '1.0.0',
    eventId: `plat-evt-${seed}-${i}`,
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    sequence: i,
    occurredAt: '2026-08-30T00:00:00.000Z',
    committedAt: '2026-08-30T00:00:00.000Z',
    eventType: 'VulnerabilityObserved',
    sourceObservationIds: [],
    featureSnapshotRef: null,
    taxonomySnapshotRef: null,
    payload: { targetId: `t${randInt(rng, 1, 3)}`, probeId: `p${randInt(rng, 1, 4)}:s${randInt(rng, 1, 2)}`, verdict: pick(rng, REPLAY_VERDICTS) },
  }));
}

const NAMESPACES: NativeMetric['namespace'][] = ['promptfoo', 'duo', 'frozen'];

function randomMetrics(seed: number): NativeMetric[] {
  const rng = mulberry32(seed);
  const count = randInt(rng, 1, 6);
  return Array.from({ length: count }, (_, i) => ({
    namespace: pick(rng, NAMESPACES),
    name: `metric-${i}`,
    value: rng() * 10,
  }));
}

function validObservationFixture() {
  return {
    id: 'obs-1',
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    probeId: 'probe-1',
    assessmentRunId: 'run-1',
    verdict: 'UNVERIFIED',
    evidenceRefs: [],
    provenance: {
      engineId: 'promptfoo',
      engineVersion: '0.122.0',
      adapterVersion: '0.1.0',
      schemaVersion: '1.0.0',
      nativeRunId: 'native-run-1',
      nativeResultId: 'native-result-1',
      graderKind: 'llm-judge',
    },
  };
}

function validFindingFixture() {
  return {
    id: 'finding-1',
    schemaVersion: '1.0.0',
    targetId: 'target-1',
    verdict: 'VULNERABLE',
    observationIds: ['obs-1'],
    severity: 'high',
  };
}

// ARCHITECTURE.md §8 — laws not already covered by FROZEN_INTEGRATION.md §10.
export const platformLaws: Law[] = [
  {
    id: 'redteam.adapter/unsupported-capability-is-rejected',
    statement:
      "checkCapabilities() rejects iff at least one required capability is undeclared, and reports every missing one, not just the first. DuoLlmCliAdapter.run() calls it before touching execFn at all — given today's real DECLARED_CAPABILITIES (all four false, ARCHITECTURE.md §9 Phase R), it never invokes the injected exec function, proving the rejection happens before execution rather than being discovered as an exec failure.",
    status: 'implemented',
    trials: 200,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const declared: EngineAdapterCapabilities = {
        realTargetProvider: randBool(rng),
        strategiesConnected: randBool(rng),
        mandatoryGrading: randBool(rng),
        deterministicScoring: randBool(rng),
      };
      const required = ALL_ENGINE_ADAPTER_CAPABILITIES.filter(() => randBool(rng, 0.7));
      const expectedMissing = required.filter((c) => !declared[c]);

      const result = checkCapabilities(declared, required);
      if (result.permitted !== (expectedMissing.length === 0)) {
        return { held: false, detail: 'permitted did not match whether every required capability was declared', counterexample: { declared, required, result } };
      }
      if (result.missing.length !== expectedMissing.length || !expectedMissing.every((c) => result.missing.includes(c))) {
        return { held: false, detail: 'missing list did not match every undeclared required capability', counterexample: { declared, required, expectedMissing, result } };
      }

      let execCalled = false;
      const adapter = new DuoLlmCliAdapter(async () => {
        execCalled = true;
        return { stdout: '{}', stderr: '' };
      });
      const runResult = await adapter.run({ outputPath: '/tmp/should-never-be-read.json' });
      if (execCalled) {
        return { held: false, detail: "DuoLlmCliAdapter.run() invoked execFn despite DECLARED_CAPABILITIES failing REQUIRED_CAPABILITIES — rejection happened after execution, not before" };
      }
      if (runResult.ok) {
        return { held: false, detail: 'DuoLlmCliAdapter.run() reported ok:true despite missing every required capability', counterexample: runResult };
      }
      if (!REQUIRED_CAPABILITIES.every((c) => runResult.rejectedCapabilities?.includes(c))) {
        return { held: false, detail: 'DuoLlmCliAdapter.run() did not report all missing capabilities', counterexample: { runResult, REQUIRED_CAPABILITIES, DECLARED_CAPABILITIES } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.finding/every-finding-has-observation',
    statement: 'A Finding with zero observationIds is not a valid Finding — enforced structurally by the schema (minItems: 1).',
    status: 'implemented',
    trials: 1,
    check: () => {
      const valid = validFindingFixture();
      const okResult = validate('rtap:finding', valid);
      if (!okResult.valid) {
        return { held: false, detail: 'A valid Finding fixture failed validation', counterexample: { valid, errors: okResult.errors } };
      }
      const empty = { ...valid, observationIds: [] };
      const emptyResult = validate('rtap:finding', empty);
      if (emptyResult.valid) {
        return { held: false, detail: 'Schema accepted a Finding with zero observationIds', counterexample: empty };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/runbook-covers-unknown-effect-outcome',
    statement:
      '§15 criterion 13: rtap/RUNBOOK.md exists on disk and its content substantively covers manual resolution of UNKNOWN_EFFECT_OUTCOME — the exact terminal reason, its own named section ("Part A"), and language identifying the procedure as an operator\'s manual action, not just an incidental mention. Converts criterion 13 from a hand-declared extraEvidence.runbookExists boolean to something a caller cannot get wrong by forgetting to update it — the same move criterion 14 made for its own hardening-flag evidence.',
    status: 'implemented',
    trials: 1,
    check: () => {
      const runbookPath = join(dirname(fileURLToPath(import.meta.url)), '../../../RUNBOOK.md');
      let content: string;
      try {
        content = readFileSync(runbookPath, 'utf-8');
      } catch (err) {
        return { held: false, detail: `RUNBOOK.md not found at ${runbookPath}`, counterexample: { err: err instanceof Error ? err.message : String(err) } };
      }
      const REQUIRED_MARKERS = ['UNKNOWN_EFFECT_OUTCOME', 'Part A', 'operator'] as const;

      // The check's own discriminating power, proven alongside the real assertion —
      // the same "prove valid passes AND invalid is rejected" shape
      // redteam.finding/every-finding-has-observation uses for its schema. A
      // marker-matcher that always reports zero missing, no matter the input, would
      // make this whole law a tautology; this catches that regression in the law
      // itself, not just in RUNBOOK.md.
      const syntheticIncomplete = 'This document only mentions UNKNOWN_EFFECT_OUTCOME, nothing else it is required to.';
      const syntheticMissing = REQUIRED_MARKERS.filter((marker) => !syntheticIncomplete.includes(marker));
      if (syntheticMissing.length === 0) {
        return { held: false, detail: 'the marker check accepted synthetic content missing two of three required markers', counterexample: { syntheticIncomplete, syntheticMissing } };
      }

      const missing = REQUIRED_MARKERS.filter((marker) => !content.includes(marker));
      if (missing.length > 0) {
        return { held: false, detail: `RUNBOOK.md is missing required coverage markers: ${missing.join(', ')}`, counterexample: { missing, runbookPath } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.observation/every-observation-has-provenance',
    statement: 'An Observation without provenance is not a valid Observation — enforced structurally by the schema.',
    status: 'implemented',
    trials: 1,
    check: () => {
      const valid = validObservationFixture();
      const okResult = validate('rtap:observation', valid);
      if (!okResult.valid) {
        return { held: false, detail: 'A valid Observation fixture failed validation', counterexample: { valid, errors: okResult.errors } };
      }
      const { provenance: _dropped, ...withoutProvenance } = valid;
      const badResult = validate('rtap:observation', withoutProvenance);
      if (badResult.valid) {
        return { held: false, detail: 'Schema accepted an Observation with no provenance', counterexample: withoutProvenance };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.artifact/public-report-never-inlines-payload',
    statement:
      'A JSON/Markdown/SARIF report never contains a raw attack payload inline — only EvidenceRef. Over random Observations whose bytes live behind a content-addressed ref (a secret payload attached to no report field), none of buildJsonReport()/buildMarkdownReport()/buildSarifReport() serializes that payload, and the SARIF surface — the one report RTAP publishes outward — still references every ref, so evidence is pointed at, never carried.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const EVIDENCE_KINDS: ArtifactRef['kind'][] = ['payload', 'response', 'trace', 'snippet', 'native-report'];
      const VERDICTS = ['VULNERABLE', 'RESISTANT', 'UNVERIFIED', 'ERROR'];
      const hex = (n: number): string => Array.from({ length: n }, () => randInt(rng, 0, 15).toString(16)).join('');
      // The raw bytes that must never leak. Prefixed so it cannot collide with any
      // target id (`t*`), probe id (`p*`), or ref (`sha256:*`) the renderers emit.
      const secretPayload = `SECRET-PAYLOAD-${hex(24)}`;

      const allRefs: string[] = [];
      const observations: ObservationLike[] = Array.from({ length: randInt(rng, 1, 8) }, (_, i) => {
        const refs: ArtifactRef[] = Array.from({ length: randInt(rng, 0, 3) }, () => {
          const ref = `sha256:${hex(16)}`;
          allRefs.push(ref);
          return { ref, kind: pick(rng, EVIDENCE_KINDS) };
        });
        return {
          id: `obs-${seed}-${i}`,
          targetId: `t${randInt(rng, 1, 4)}`,
          probeId: `p${randInt(rng, 1, 4)}`,
          verdict: pick(rng, VERDICTS),
          evidenceRefs: refs,
        };
      });

      const findings = correlateFindings(observations);
      const input = { assessmentRunId: `run-${seed}`, generatedAt: '2026-09-04T00:00:00.000Z', observations, findings };

      const surfaces: Record<string, string> = {
        json: JSON.stringify(buildJsonReport(input)),
        markdown: buildMarkdownReport(input),
        sarif: JSON.stringify(buildSarifReport(input, { toolVersion: '0.0.0' })),
      };
      for (const [name, serialized] of Object.entries(surfaces)) {
        if (serialized.includes(secretPayload)) {
          return { held: false, detail: `${name} report inlined the raw payload that only ever lived behind an EvidenceRef`, counterexample: { name, secretPayload } };
        }
      }

      // Non-vacuous: the SARIF surface must actually reference the evidence — a
      // renderer that silently drops refs would pass "no payload" trivially.
      for (const ref of allRefs) {
        if (!surfaces.sarif!.includes(`rtap-artifact:${ref}`)) {
          return { held: false, detail: `SARIF dropped evidence ref ${ref} instead of referencing it`, counterexample: { ref, findings } };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.run/committed-step-is-idempotent',
    statement: 'Re-executing a durable RunStep with an already-committed idempotencyKey does not duplicate its effect.',
    status: 'pending',
    trials: 0,
    pendingReason: 'No durable RunStep engine exists yet — ARCHITECTURE.md §9 Phase 1.',
  },
  {
    id: 'redteam.score/native-scores-are-never-averaged',
    statement: 'groupNativeMetricsByNamespace() never merges values across namespaces — the number of output groups equals the number of distinct namespaces present.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const metrics = randomMetrics(seed);
      const groups = groupNativeMetricsByNamespace(metrics);
      const distinctNamespaces = new Set(metrics.map((m) => m.namespace));
      if (groups.size !== distinctNamespaces.size) {
        return {
          held: false,
          detail: `Expected ${distinctNamespaces.size} groups, got ${groups.size}`,
          counterexample: { metrics, groups: [...groups.entries()] },
        };
      }
      for (const [namespace, values] of groups) {
        const expectedCount = metrics.filter((m) => m.namespace === namespace).length;
        if (values.length !== expectedCount) {
          return {
            held: false,
            detail: `Namespace ${namespace} lost or gained values`,
            counterexample: { metrics, groups: [...groups.entries()] },
          };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.replay/same-events-produce-same-state',
    statement:
      'ARCHITECTURE.md §8 vs FROZEN_INTEGRATION.md §10.1 name this independently — both IDs kept as published rather than silently merged. Checked as a structural claim distinct from the sibling law\'s hash comparison: two independent replays of the same events produce a world with the same entity count, relation count and epoch, not just the same fingerprint.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const events = syntheticEventStreamForReplay(seed, randInt(mulberry32(seed + 3), 3, 15));
      const a = replay(events, 'campaign-1', 0).world;
      const b = replay(events, 'campaign-1', 0).world;

      if (a.entities.size !== b.entities.size || a.relations.length !== b.relations.length || a.epoch !== b.epoch) {
        return {
          held: false,
          detail: 'Two replays of identical events produced structurally different worlds',
          counterexample: {
            entitiesA: a.entities.size,
            entitiesB: b.entities.size,
            relationsA: a.relations.length,
            relationsB: b.relations.length,
            epochA: a.epoch,
            epochB: b.epoch,
          },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/schema-migrations-apply-exactly-once-in-order',
    statement:
      'applyMigrations() applies an arbitrary set of migrations exactly once each, in ascending id order, regardless of the order they were supplied in — and a second call against the same database applies nothing further. Audit finding P0#1: CREATE TABLE IF NOT EXISTS alone never updated an existing table when a later change added a column, so this is the mechanism that replaced it.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const count = randInt(rng, 2, 8);
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      const migrations: Migration[] = ids.map((id) => ({ id, name: `m${id}`, up: (d) => d.exec(`CREATE TABLE t${id} (id TEXT PRIMARY KEY)`) }));
      const shuffled = [...migrations].sort(() => rng() - 0.5);

      const db = new DatabaseSync(':memory:');
      applyMigrations(db, shuffled);

      const applied = listAppliedMigrations(db);
      if (applied.length !== count || applied.map((m) => m.id).some((id, i) => id !== ids[i])) {
        return { held: false, detail: 'migrations were not applied exactly once each in ascending id order', counterexample: { ids, applied } };
      }

      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't%'`).all() as { name: string }[];
      if (tables.length !== count) {
        return { held: false, detail: `expected ${count} tables, found ${tables.length}`, counterexample: { ids, tables } };
      }

      // A second call, in yet another random order, must be a complete no-op.
      applyMigrations(db, [...migrations].sort(() => rng() - 0.5));
      if (listAppliedMigrations(db).length !== count) {
        return { held: false, detail: 'a second applyMigrations() call re-applied or duplicated a migration', counterexample: { ids, applied: listAppliedMigrations(db) } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/outbox-materialization-matches-full-replay',
    statement:
      'Audit finding #4: CampaignWorldMaterializer.advance(), reading the outbox row every CampaignEventStore.append() now writes and resuming from its own persisted materialized_worlds cursor, produces a world that fingerprints identically to world/replay.ts\'s from-scratch replay() of the same committed events — whether advance() is called once or split across several calls (simulating a crash and restart mid-stream) against fresh CampaignWorldMaterializer instances sharing the same database. ARCH_CLAUDE_TRANSFER.md §2.6: pruneDeliveredOutbox(), called at arbitrary points during that same replay, never removes a row advance() still needs, and never changes the final fingerprint from what an unpruned run would have produced.',
    status: 'implemented',
    trials: 150,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const count = randInt(rng, 3, 20);
      const chunkCount = randInt(rng, 1, 4);
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const outbox = new OutboxStore(db);
      const campaignId = 'campaign-1';

      // Interleave committing events with advance() calls against a *fresh*
      // CampaignWorldMaterializer instance each time — simulating a crash and
      // restart between batches, proving resumption relies on the persisted
      // materialized_worlds cursor and outbox rows, not in-process object state.
      let materialized = null;
      for (let c = 0; c < chunkCount; c += 1) {
        const remaining = count - c * Math.floor(count / chunkCount);
        const batchSize = c === chunkCount - 1 ? remaining : Math.floor(count / chunkCount);
        for (let i = 0; i < batchSize; i += 1) {
          const index = c * Math.floor(count / chunkCount) + i;
          const input: CampaignEventInput = {
            schemaVersion: '1.0.0',
            eventId: `mat-evt-${seed}-${index}`,
            campaignId,
            assessmentRunId: 'run-1',
            occurredAt: '2026-08-30T00:00:00.000Z',
            eventType: 'VulnerabilityObserved',
            sourceObservationIds: [],
            featureSnapshotRef: null,
            taxonomySnapshotRef: null,
            payload: { targetId: `t${randInt(rng, 1, 3)}`, probeId: `p${randInt(rng, 1, 4)}:s${randInt(rng, 1, 2)}`, verdict: pick(rng, REPLAY_VERDICTS) },
          };
          events.append(input);
        }

        const materializer = new CampaignWorldMaterializer(db, events, outbox);
        const result = materializer.advance(campaignId);
        if (result.stoppedAt) {
          return { held: false, detail: 'materializer.advance() stopped unexpectedly on a real committed event stream', counterexample: { seed, count, chunk: c, stoppedAt: result.stoppedAt } };
        }
        materialized = result.world;

        // Prune on roughly two of every three chunks — the other third proves an
        // un-pruned outbox coexists safely with a pruned one across restarts.
        if (randBool(rng, 0.66)) {
          materializer.pruneDeliveredOutbox(campaignId);
          const remaining = outbox.listAll(campaignId);
          // Every row at or before the watermark was, by advance()'s own construction,
          // marked delivered in the same transaction that advanced lastSequence past
          // it — so none should survive pruning at all, not just the delivered ones.
          // A surviving undelivered row at-or-before the watermark would mean advance()
          // itself lied about what it applied, a bug this law would rather surface here
          // than let pruning silently paper over.
          const survivedAtOrBeforeWatermark = remaining.filter((row) => row.sequence <= materialized!.lastSequence);
          if (survivedAtOrBeforeWatermark.length > 0) {
            return { held: false, detail: 'a row at or before the watermark survived pruneDeliveredOutbox()', counterexample: { watermark: materialized.lastSequence, survivedAtOrBeforeWatermark } };
          }
        }
      }

      if (!materialized) {
        return { held: false, detail: 'no advance() call ran', counterexample: { seed, count, chunkCount } };
      }

      const replayed = replay(events.listByCampaign(campaignId), campaignId).world;

      if (fingerprint(materialized) !== fingerprint(replayed)) {
        return {
          held: false,
          detail: 'incremental materialization diverged from full replay',
          counterexample: { seed, count, chunkCount, materializedFingerprint: fingerprint(materialized), replayedFingerprint: fingerprint(replayed) },
        };
      }
      if (materialized.lastSequence !== replayed.lastSequence) {
        return { held: false, detail: 'lastSequence diverged despite matching fingerprint', counterexample: { materializedLastSequence: materialized.lastSequence, replayedLastSequence: replayed.lastSequence } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.world/corrupted-cache-falls-back-to-replay',
    statement:
      'грань №14 (Грани Arch_claude): CampaignWorldMaterializer.current() never throws and never returns a wrong world when materialized_worlds.state_json has been corrupted independently of the write path that produced it — whether corrupted into invalid JSON, or valid JSON with a tampered field the world_snapshots row (taken in the same transaction as the original write) disagrees with. Either way, current() falls back to a full world/replay.ts replay() of the canonical CampaignEventStore, fingerprinting identically to it.',
    status: 'implemented',
    trials: 150,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const count = randInt(rng, 1, 12);
      const db = openInMemoryDatabase();
      const events = new CampaignEventStore(db);
      const campaignId = 'campaign-1';

      for (let i = 0; i < count; i += 1) {
        const input: CampaignEventInput = {
          schemaVersion: '1.0.0',
          eventId: `snap-evt-${seed}-${i}`,
          campaignId,
          assessmentRunId: 'run-1',
          occurredAt: '2026-08-30T00:00:00.000Z',
          eventType: 'VulnerabilityObserved',
          sourceObservationIds: [],
          featureSnapshotRef: null,
          taxonomySnapshotRef: null,
          payload: { targetId: `t${randInt(rng, 1, 3)}`, probeId: `p${randInt(rng, 1, 4)}:s${randInt(rng, 1, 2)}`, verdict: pick(rng, REPLAY_VERDICTS) },
        };
        events.append(input);
      }

      const materializer = new CampaignWorldMaterializer(db, events);
      const advanceResult = materializer.advance(campaignId);
      if (advanceResult.stoppedAt) {
        return { held: false, detail: 'materializer.advance() stopped unexpectedly on a real committed event stream', counterexample: { seed, count, stoppedAt: advanceResult.stoppedAt } };
      }

      const corruptionKind = pick(rng, ['none', 'invalid-json', 'tampered-field'] as const);
      if (corruptionKind === 'invalid-json') {
        db.prepare(`UPDATE materialized_worlds SET state_json = 'not valid json{{{' WHERE campaign_id = @campaignId`).run({ campaignId });
      } else if (corruptionKind === 'tampered-field') {
        const row = db.prepare(`SELECT state_json FROM materialized_worlds WHERE campaign_id = @campaignId`).get({ campaignId }) as { state_json: string };
        const tampered = { ...JSON.parse(row.state_json), lastSequence: (JSON.parse(row.state_json).lastSequence as number) + 1000 };
        db.prepare(`UPDATE materialized_worlds SET state_json = @stateJson WHERE campaign_id = @campaignId`).run({ campaignId, stateJson: JSON.stringify(tampered) });
      }

      let recovered: ReturnType<CampaignWorldMaterializer['current']>;
      try {
        recovered = materializer.current(campaignId);
      } catch (err) {
        return { held: false, detail: `current() threw instead of falling back to replay()`, counterexample: { seed, corruptionKind, err: err instanceof Error ? err.message : String(err) } };
      }

      if (!recovered) {
        return { held: false, detail: 'current() returned null for a campaign advance() had just materialized', counterexample: { seed, corruptionKind } };
      }

      const replayed = replay(events.listByCampaign(campaignId), campaignId).world;
      if (fingerprint(recovered) !== fingerprint(replayed)) {
        return {
          held: false,
          detail: 'current() returned a world that does not match a full replay',
          counterexample: { seed, corruptionKind, recoveredFingerprint: fingerprint(recovered), replayedFingerprint: fingerprint(replayed) },
        };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.artifact/coverage-denominator-is-never-assumed',
    statement:
      "ARCH_CLAUDE_TRANSFER.md §2.4: a probe that was scheduled and never resolved is never silently indistinguishable from one that ran and found nothing. Over a random schedule of N probes of which only M resolve, the replayed CampaignWorld's scheduledUnresolved always holds exactly the N-M outstanding pairs; buildAssessmentReport() refuses with UNRESOLVED_COVERAGE whenever any remain, and refuses with UNKNOWN_COVERAGE whenever no coverage information was supplied at all — a caller can obtain an ok report only by actually establishing full coverage. ExecutionFailed resolves a probe (a known error is an outcome), which is exactly the distinction the set exists to preserve.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const scheduledCount = randInt(rng, 1, 8);
      const resolvedCount = randInt(rng, 0, scheduledCount);
      const pairs = Array.from({ length: scheduledCount }, (_, i) => ({ targetId: `target-${i % 3}`, probeId: `class-${i}:strategy-${i}` }));

      const events: CampaignEventEnvelope[] = [];
      let sequence = 0;
      const envelope = (eventType: string, payload: Record<string, unknown>): CampaignEventEnvelope => ({
        schemaVersion: '1.0.0',
        eventId: `evt-${sequence}`,
        campaignId: 'campaign-1',
        assessmentRunId: 'run-1',
        sequence: sequence++,
        occurredAt: new Date(0).toISOString(),
        committedAt: new Date(0).toISOString(),
        eventType,
        sourceObservationIds: [],
        featureSnapshotRef: null,
        taxonomySnapshotRef: null,
        payload,
      }) as unknown as CampaignEventEnvelope;

      for (const p of pairs) events.push(envelope('ProbeScheduled', { targetId: p.targetId, probeId: p.probeId }));
      for (let i = 0; i < resolvedCount; i += 1) {
        const verdict = pick(rng, REPLAY_VERDICTS);
        const eventType = verdict === 'VULNERABLE' ? 'VulnerabilityObserved' : verdict === 'RESISTANT' ? 'ResistanceObserved' : verdict === 'UNVERIFIED' ? 'ObservationUnverified' : 'ExecutionFailed';
        events.push(envelope(eventType, { targetId: pairs[i]!.targetId, probeId: pairs[i]!.probeId, verdict }));
      }

      const world = replay(events, 'campaign-1').world;
      const expectedOutstanding = scheduledCount - resolvedCount;
      if (world.scheduledUnresolved.size !== expectedOutstanding) {
        return {
          held: false,
          detail: `scheduled ${scheduledCount}, resolved ${resolvedCount}, expected ${expectedOutstanding} outstanding but world holds ${world.scheduledUnresolved.size}`,
          counterexample: { scheduledCount, resolvedCount, outstanding: [...world.scheduledUnresolved] },
        };
      }

      const withCoverage = buildAssessmentReport({
        assessmentRunId: 'run-1',
        generatedAt: new Date(0).toISOString(),
        observations: [],
        findings: [],
        coverage: { scheduled: scheduledCount, unresolved: [...world.scheduledUnresolved] },
      });
      if (expectedOutstanding > 0) {
        if (withCoverage.ok) return { held: false, detail: 'a report with unresolved coverage was accepted', counterexample: { expectedOutstanding, report: withCoverage.report.coverage } };
        if (withCoverage.reason !== 'UNRESOLVED_COVERAGE') return { held: false, detail: `refused for the wrong reason: ${withCoverage.reason}`, counterexample: withCoverage };
      } else {
        if (!withCoverage.ok) return { held: false, detail: 'a fully resolved run was still refused', counterexample: withCoverage };
        if (withCoverage.report.coverage.status !== 'COMPLETE') return { held: false, detail: 'a fully resolved run was not marked COMPLETE', counterexample: withCoverage.report.coverage };
      }

      // Omitting coverage entirely must never read as proof of completeness.
      const withoutCoverage = buildAssessmentReport({ assessmentRunId: 'run-1', generatedAt: new Date(0).toISOString(), observations: [], findings: [] });
      if (withoutCoverage.ok) return { held: false, detail: 'a report with no coverage information at all was accepted as complete', counterexample: withoutCoverage };
      if (withoutCoverage.reason !== 'UNKNOWN_COVERAGE') return { held: false, detail: `unsupplied coverage refused for the wrong reason: ${withoutCoverage.reason}` };
      if (withoutCoverage.report.coverage.status !== 'UNKNOWN') return { held: false, detail: 'unsupplied coverage was not reported as UNKNOWN' };

      return { held: true };
    },
  },
  {
    id: 'redteam.execution/settled-attempt-is-not-an-unattempted-candidate',
    statement:
      "ARCH_CLAUDE_TRANSFER.md §2.5: a settled ExecutionAttempt with no committed CampaignEvent is not the same as \"never attempted\" — enumerateEligibleCandidates(), fed a real CampaignHistoryView built end-to-end from a real ExecutionAttemptStore/RunStepStore (RunStepStore.enqueue() -> lease() -> ExecutionAttemptStore.start() -> markTerminal(), buildSettledAttemptsByReason(), buildHistoryView()), excludes a probe with zero committed outcomes iff its one settled attempt's TerminalReason is one blocksEligibility() itself calls blocking — never for any other reason, including TARGET_UNAVAILABLE (ordinary resource contention, not a failed attempt).",
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const ALL_TERMINAL_REASONS: TerminalReason[] = [
        'COMPLETED',
        'CANCELLED',
        'TIMED_OUT_BEFORE_EFFECT',
        'AUTHORIZATION_DENIED',
        'CAPABILITY_UNSUPPORTED',
        'TARGET_UNAVAILABLE',
        'FAILED_BEFORE_EFFECT',
        'UNKNOWN_EFFECT_OUTCOME',
        'NORMALIZATION_FAILED',
        'STALE_LEASE_RESULT',
        'OBSERVATION_COMMITTED',
      ];
      const reason = pick(rng, ALL_TERMINAL_REASONS);

      const db = openInMemoryDatabase();
      const runSteps = new RunStepStore(db);
      const attempts = new ExecutionAttemptStore(db, runSteps);

      const { step } = runSteps.enqueue(
        'run-1',
        `key-${seed}`,
        { campaignId: 'campaign-1', targetId: 't1', probeId: 'p1:s1' },
        new Date(0),
        { campaignId: 'campaign-1', targetId: 't1' },
      );
      runSteps.lease('run-1', { owner: 'w1', leaseDurationMs: 60_000, now: () => new Date(0) });
      const attempt = attempts.start(
        { assessmentRunId: 'run-1', runStepId: step.id, engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0', engineRequestId: `req-${seed}` },
        new Date(0),
      );
      attempts.markTerminal(attempt.executionAttemptId, reason, new Date(0));

      const settledAttemptsByReason = buildSettledAttemptsByReason(attempts.listByCampaign('campaign-1'), runSteps);
      const history = buildHistoryView([], 'campaign-1', 0, settledAttemptsByReason);

      const catalog: ProbeCatalogEntry[] = [{ probeId: 'p1:s1', mandatory: false }];
      const result = enumerateEligibleCandidates(catalog, 't1', history);

      const isEligible = result.eligible.some((c) => c.probeId === 'p1:s1');
      const expectedEligible = !blocksEligibility(reason);
      if (isEligible !== expectedEligible) {
        return {
          held: false,
          detail: `TerminalReason ${reason}: expected eligible=${expectedEligible}, got ${isEligible}`,
          counterexample: { reason, result, settledAttemptsByReason: [...settledAttemptsByReason.entries()].map(([k, v]) => [k, v]) },
        };
      }
      if (!expectedEligible) {
        const excludeReason = result.excludedReasons['p1:s1'];
        if (!excludeReason?.includes(reason)) {
          return { held: false, detail: 'excludedReasons did not name the actual blocking TerminalReason', counterexample: { reason, excludeReason } };
        }
      }

      // The same probe on a different target is never touched by this attempt's identity.
      const otherTarget = enumerateEligibleCandidates(catalog, 't2', history);
      if (!otherTarget.eligible.some((c) => c.probeId === 'p1:s1')) {
        return { held: false, detail: 'a settled attempt against t1 incorrectly excluded the same probe against an unrelated target t2', counterexample: { reason, otherTarget } };
      }

      return { held: true };
    },
  },
  // грань №20 — assessment_runs: the missing aggregate row ARCH_CLAUDE_TRANSFER.md
  // §2.4 step 4 specifies. Six laws: creation identity, current-state semantics for
  // intelligence_status, its separate sticky audit trail, coverage acceptance's
  // idempotent claim, the report/acceptance decoupling pinned as an invariant, and
  // the real (if one layer below runPlannerOnce()) fallback-to-DEGRADED round trip.
  {
    id: 'redteam.platform/assessment-run-start-is-idempotent-by-campaign',
    statement:
      'AssessmentRunStore.start() called twice with the same (assessmentRunId, campaignId) is a no-op — returns the identical record, never a second row, never refreshes startedAt. A second start() naming a different campaignId for the same assessmentRunId throws AssessmentRunCampaignMismatchError and leaves the original row untouched — an id collision across two logically different runs is a real mistake, not a retry.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const store = new AssessmentRunStore(db);
      const assessmentRunId = `run-${seed}`;
      const campaignId = `campaign-${randInt(rng, 1, 5)}`;
      const otherCampaignId = `campaign-${randInt(rng, 6, 10)}`;

      const first = store.start(assessmentRunId, campaignId, new Date(0));
      const second = store.start(assessmentRunId, campaignId, new Date(60_000 * randInt(rng, 1, 1000)));
      if (JSON.stringify(second) !== JSON.stringify(first)) {
        return { held: false, detail: 'a repeated start() with the same campaignId returned a different record instead of the original', counterexample: { first, second } };
      }

      const count = (db.prepare(`SELECT COUNT(*) as n FROM assessment_runs`).get() as { n: number }).n;
      if (count !== 1) {
        return { held: false, detail: 'a repeated start() created a second row', counterexample: { count } };
      }

      let threw = false;
      try {
        store.start(assessmentRunId, otherCampaignId, new Date(999_000_000));
      } catch (err) {
        threw = err instanceof AssessmentRunCampaignMismatchError;
      }
      if (!threw) {
        return { held: false, detail: 'start() with a mismatched campaignId did not throw AssessmentRunCampaignMismatchError', counterexample: { assessmentRunId, campaignId, otherCampaignId } };
      }

      const afterMismatch = store.get(assessmentRunId)!;
      if (afterMismatch.campaignId !== campaignId) {
        return { held: false, detail: 'a rejected start() call still corrupted the original campaignId', counterexample: { afterMismatch, campaignId } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/intelligence-status-reflects-only-the-latest-call',
    statement:
      "FROZEN_INTEGRATION.md:136 vs its own transient framing (\"после восстановления worker выполняет replay\"): AssessmentRunStore.recordIntelligenceStatus() never latches DEGRADED into intelligence_status itself — over a random sequence of HEALTHY/DEGRADED writes, get().intelligenceStatus after the sequence always equals the LAST status written, regardless of how many DEGRADED writes preceded it. Against an assessmentRunId with no start() row, it is a safe no-op — recorded:false, record:null, no row created, never a throw.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const store = new AssessmentRunStore(db);
      const assessmentRunId = `run-${seed}`;

      const beforeStart = store.recordIntelligenceStatus(assessmentRunId, pick(rng, ['HEALTHY', 'DEGRADED'] as const));
      if (beforeStart.recorded || beforeStart.record !== null) {
        return { held: false, detail: 'recordIntelligenceStatus() against a never-started run reported recorded:true or a non-null record', counterexample: beforeStart };
      }
      if (store.get(assessmentRunId) !== null) {
        return { held: false, detail: 'recordIntelligenceStatus() against a never-started run created a row', counterexample: { assessmentRunId } };
      }

      store.start(assessmentRunId, 'campaign-1', new Date(0));
      const sequenceLength = randInt(rng, 3, 12);
      const sequence: IntelligenceStatus[] = Array.from({ length: sequenceLength }, () => pick(rng, ['HEALTHY', 'DEGRADED'] as const));
      let lastResult;
      for (let i = 0; i < sequence.length; i += 1) {
        lastResult = store.recordIntelligenceStatus(assessmentRunId, sequence[i]!, new Date((i + 1) * 1000));
      }

      const finalStatus = sequence[sequence.length - 1]!;
      const record = store.get(assessmentRunId)!;
      if (record.intelligenceStatus !== finalStatus) {
        return { held: false, detail: `expected the last-written status ${finalStatus}, got ${record.intelligenceStatus} — status latched or was overwritten incorrectly`, counterexample: { sequence, record } };
      }
      if (!lastResult!.recorded || lastResult!.record?.intelligenceStatus !== finalStatus) {
        return { held: false, detail: 'the final recordIntelligenceStatus() call did not report recorded:true with the status it just wrote', counterexample: lastResult };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/ever-degraded-is-a-sticky-audit-flag',
    statement:
      "грань №20's honest complement to intelligence_status's own non-monotonicity: AssessmentRunStore.recordIntelligenceStatus()'s everDegradedAt is stamped once, on the first-ever transition into DEGRADED, and — unlike intelligence_status itself — is never cleared by any number of subsequent HEALTHY (or repeat DEGRADED) writes. Over a random sequence of HEALTHY/DEGRADED writes, everDegradedAt is null iff DEGRADED never appeared in the sequence, and once set, equals the timestamp of the FIRST DEGRADED write, never a later one.",
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const store = new AssessmentRunStore(db);
      const assessmentRunId = `run-${seed}`;
      store.start(assessmentRunId, 'campaign-1', new Date(0));

      const sequenceLength = randInt(rng, 2, 10);
      const sequence: IntelligenceStatus[] = Array.from({ length: sequenceLength }, () => pick(rng, ['HEALTHY', 'DEGRADED'] as const));
      let firstDegradedAt: string | null = null;
      let lastResult;
      for (let i = 0; i < sequence.length; i += 1) {
        const now = new Date((i + 1) * 1000);
        lastResult = store.recordIntelligenceStatus(assessmentRunId, sequence[i]!, now);
        if (sequence[i] === 'DEGRADED' && firstDegradedAt === null) {
          firstDegradedAt = now.toISOString();
        }
      }

      const record = store.get(assessmentRunId)!;
      if (firstDegradedAt === null) {
        if (record.everDegradedAt !== null) {
          return { held: false, detail: 'everDegradedAt was set despite DEGRADED never appearing in the sequence', counterexample: { sequence, record } };
        }
      } else if (record.everDegradedAt !== firstDegradedAt) {
        return { held: false, detail: 'everDegradedAt did not equal the timestamp of the first DEGRADED write', counterexample: { sequence, firstDegradedAt, record } };
      }
      if (!lastResult?.recorded) {
        return { held: false, detail: 'the final write in the sequence was not recorded', counterexample: lastResult };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/coverage-acceptance-first-decision-wins',
    statement:
      'AssessmentRunStore.acceptCoverage() claims exactly once, the same WHERE-guarded UPDATE idiom PendingApprovalStore.resolve()/SigningKeyStore.revoke() already use: the first call wins and permanently records note/acceptedBy/acceptedAt, a second (racing or repeated) call always reports ALREADY_ACCEPTED with the original acceptance rather than overwriting it, and a call against a never-started run reports NOT_FOUND without creating a row.',
    status: 'implemented',
    trials: 200,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const store = new AssessmentRunStore(db);
      const assessmentRunId = `run-${seed}`;
      const operatorA = `operator-a-${seed}`;
      const operatorB = `operator-b-${seed}`;

      const beforeStart = store.acceptCoverage(assessmentRunId, 'note before start', operatorA);
      if (beforeStart.accepted || beforeStart.reason !== 'NOT_FOUND') {
        return { held: false, detail: 'acceptCoverage() against a never-started run did not report NOT_FOUND', counterexample: beforeStart };
      }

      store.start(assessmentRunId, 'campaign-1', new Date(0));
      const noteA = `note-a-${seed}`;
      const first = store.acceptCoverage(assessmentRunId, noteA, operatorA, new Date(1000));
      if (!first.accepted || first.record.acceptedBy !== operatorA) {
        return { held: false, detail: 'the first acceptCoverage() call did not win', counterexample: first };
      }

      const second = store.acceptCoverage(assessmentRunId, `note-b-${seed}`, operatorB, new Date(1000 + randInt(rng, 1, 100_000)));
      if (second.accepted || second.reason !== 'ALREADY_ACCEPTED' || second.record.acceptedBy !== operatorA) {
        return { held: false, detail: 'a second acceptCoverage() call did not report ALREADY_ACCEPTED with the original acceptor', counterexample: { first, second } };
      }

      const record = store.get(assessmentRunId)!;
      if (record.coverageAcceptance !== noteA || record.acceptedBy !== operatorA || record.acceptedAt !== first.record.acceptedAt) {
        return { held: false, detail: 'the stored row does not match the first, winning acceptance', counterexample: record };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/report-is-not-gated-on-coverage-acceptance',
    statement:
      "грань №20's deliberate scope boundary, pinned as a checkable invariant: buildAssessmentReport()'s ok/refusal outcome for a given ReportInput never depends on whether AssessmentRunStore.acceptCoverage() has been called for the same assessmentRunId. ARCH_CLAUDE_TRANSFER.md §2.4 specifies the coverage_acceptance column's name, not any report-refusal behavior for it — this law exists so a later change cannot silently start reading it without a new law explicitly replacing this one.",
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const store = new AssessmentRunStore(db);
      const assessmentRunId = `run-${seed}`;
      store.start(assessmentRunId, 'campaign-1', new Date(0));

      const input = {
        assessmentRunId,
        generatedAt: new Date(0).toISOString(),
        observations: [],
        findings: [],
        coverage: { scheduled: 3, unresolved: [] },
      };
      const beforeAcceptance = buildAssessmentReport(input);

      if (randBool(rng)) {
        store.acceptCoverage(assessmentRunId, 'accepted for the law', 'operator-1');
      }
      const afterMaybeAcceptance = buildAssessmentReport(input);

      if (JSON.stringify(beforeAcceptance) !== JSON.stringify(afterMaybeAcceptance)) {
        return { held: false, detail: 'buildAssessmentReport() result changed after AssessmentRunStore.acceptCoverage() was called for the same assessmentRunId', counterexample: { beforeAcceptance, afterMaybeAcceptance } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.platform/degraded-fallback-round-trips-into-assessment-run',
    statement:
      "FROZEN_INTEGRATION.md:136, proven one layer below runPlannerOnce() — the honest, currently-reachable boundary: loadFittedLinearModel()'s dot() is total (weights[i] ?? 0) and cannot throw through real config-supplied weights, so rankCandidates()'s fallback is not reachable through runPlannerOnce()'s own real model-loading path today (see грань №20's design synthesis for why a claim of full end-to-end coverage through runPlannerOnce() itself would be false — digestOfWeights() reads the same weights array before rankCandidates() ever runs, outside its try/catch). A real rankCandidates() fallback (a model whose predict() genuinely throws, the same construction redteam.planner/frozen-failure-falls-back-to-heuristic already proves triggers it) round-trips through AssessmentRunStore.start()+recordIntelligenceStatus() into a durable DEGRADED row with everDegradedAt stamped.",
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const history = buildHistoryView([], 'campaign-1', 0);
      const featureCount = randInt(rng, 1, 6);
      const features = Array.from({ length: featureCount }, (_, i) =>
        compileCandidateFeatures({ targetId: 't1', probe: { probeId: `p${i}:s1` }, budget: { targetCallsUsed: 0, targetCallsBudget: 100 } }, history),
      );
      const world = { worldGeneration: 0, worldEpoch: randInt(rng, 0, 50) };
      const throwingModel = {
        name: 'flaky',
        predict: () => {
          throw new Error(`simulated model failure ${seed}`);
        },
      };

      const ranking = rankCandidates(throwingModel, 'flaky-model', features, world, 'SHADOW');
      if (!ranking.usedFallback) {
        return { held: false, detail: 'law setup: rankCandidates() did not report usedFallback for a genuinely throwing model', counterexample: ranking };
      }

      const db = openInMemoryDatabase();
      const store = new AssessmentRunStore(db);
      const assessmentRunId = `run-${seed}`;
      store.start(assessmentRunId, 'campaign-1', new Date(0));
      const result = store.recordIntelligenceStatus(assessmentRunId, ranking.usedFallback ? 'DEGRADED' : 'HEALTHY', new Date(1000));

      if (!result.recorded || result.record?.intelligenceStatus !== 'DEGRADED') {
        return { held: false, detail: 'a genuine rankCandidates() fallback did not persist as DEGRADED', counterexample: { ranking, result } };
      }
      if (result.record.everDegradedAt === null) {
        return { held: false, detail: 'the first DEGRADED write did not stamp everDegradedAt', counterexample: result.record };
      }
      return { held: true };
    },
  },
];
