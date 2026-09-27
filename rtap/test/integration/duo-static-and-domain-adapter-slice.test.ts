import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { commitObservationWithEvent } from '../../src/pipeline/commit-observation.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { parseDuoStaticScan, type ParseContext } from '../../src/adapters/duo-static/parse.js';
import { replay } from '../../src/world/replay.js';
import { worldPositionOf } from '../../src/world/binding.js';
import { DomainAdapterRegistry } from '../../src/domain-adapters/registry.js';
import { evaluateAdapterAdmission, cellKey, type CrossDomainMatrix } from '../../src/domain-adapters/matrix.js';
import type { DomainAdapterMetadata } from '../../src/domain-adapters/metadata.js';
import type { DuoStaticScanResult } from '../../src/adapters/duo-static/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '../fixtures/duo-static-scan-result.json'), 'utf-8')) as DuoStaticScanResult;

/**
 * Phase 6 vertical slice, two independent halves:
 *
 * 1. Real duo-agents scan output (extracted from an actual gitlabhq scan, not
 *    hand-written) -> ACL parse -> committed Observations -> the *same* Phase 4
 *    world reducer used for promptfoo events, unmodified, because reducer.ts derives
 *    Target/ProbeClass/relations from the generic {targetId, probeId, verdict}
 *    payload shape every adapter already commits to — no duo-specific branch needed.
 * 2. A domain adapter admitted via a real cross-domain matrix, swapped in at a run
 *    boundary, then rolled back.
 */
describe('Phase 6 vertical slice: duo static fusion + domain adapter admission', () => {
  it('duo-static Observations commit and replay into the same CampaignWorld reducer as promptfoo events', () => {
    const db = openInMemoryDatabase();
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    const ctx: ParseContext = { assessmentRunId: 'run-1', targetId: 'target-gitlabhq', engineVersion: '0.1.0', adapterVersion: '0.1.0' };
    const parsed = parseDuoStaticScan(fixture, ctx);

    for (const observation of parsed) {
      commitObservationWithEvent(
        db,
        observations,
        events,
        observation,
        eventForObservation(observation, { campaignId: 'campaign-repo-scan', assessmentRunId: ctx.assessmentRunId, occurredAt: fixture.timestamp }),
      );
    }

    const allEvents = events.listByCampaign('campaign-repo-scan');
    expect(allEvents).toHaveLength(fixture.findings.length);
    // Every duo-static observation is UNVERIFIED, so the generic reducer maps its
    // event to ObservationUnverified — see observation-event.ts's verdict table.
    expect(allEvents.every((e) => e.eventType === 'ObservationUnverified')).toBe(true);

    const result = replay(allEvents, 'campaign-repo-scan');
    expect(result.stoppedAt).toBeNull();
    expect(result.world.entities.get('target-gitlabhq')).toMatchObject({ type: 'Target' });

    const probeClasses = [...result.world.entities.values()].filter((e) => e.type === 'ProbeClass');
    const distinctPlugins = new Set(fixture.findings.map((f) => f.plugin));
    expect(probeClasses.length).toBe(distinctPlugins.size);

    const position = worldPositionOf(result.world);
    expect(position.worldEpoch).toBe(fixture.findings.length);
  });

  it('an adapter admitted by a real cross-domain matrix can be swapped in, then rolled back', () => {
    const db = openInMemoryDatabase();
    const registry = new DomainAdapterRegistry(db);

    const matrix: CrossDomainMatrix = {
      adapterScores: new Map([
        [cellKey('coding-agent-adp', 'coding-agent'), 0.82],
        [cellKey('coding-agent-adp', 'financial'), 0.47], // at or below baseline — no off-domain gain
      ]),
      baselineScores: new Map([
        ['coding-agent', 0.65],
        ['financial', 0.5],
      ]),
    };
    const admission = evaluateAdapterAdmission(matrix, 'coding-agent-adp', 'coding-agent');
    expect(admission.admitted).toBe(true);

    const metadata: DomainAdapterMetadata = { adapterRef: 'coding-agent-adp', domain: 'coding-agent', parentCoreRef: 'core-general-v1', reassignEvery: 0 };
    const swap = registry.swap({ domain: 'coding-agent', newAdapterRef: 'coding-agent-adp', timing: 'RUN_BOUNDARY' }, admission, metadata);
    expect(swap.allowed).toBe(true);
    expect(registry.getActive('coding-agent')).toBe('coding-agent-adp');

    // Regression discovered post-swap — roll back rather than leaving a degraded
    // adapter active.
    const rollback = registry.rollback('coding-agent');
    expect(rollback.allowed).toBe(true);
    expect(registry.getActive('coding-agent')).toBeNull(); // there was no adapter active before this one
  });

  it('a mid-run swap attempt on the same domain is rejected, leaving the active adapter untouched', () => {
    const db = openInMemoryDatabase();
    const registry = new DomainAdapterRegistry(db);
    const matrix: CrossDomainMatrix = {
      adapterScores: new Map([[cellKey('a1', 'coding-agent'), 0.8]]),
      baselineScores: new Map([['coding-agent', 0.6]]),
    };
    const admission = evaluateAdapterAdmission(matrix, 'a1', 'coding-agent');
    const metadata: DomainAdapterMetadata = { adapterRef: 'a1', domain: 'coding-agent', parentCoreRef: 'core-1', reassignEvery: 0 };
    registry.swap({ domain: 'coding-agent', newAdapterRef: 'a1', timing: 'RUN_BOUNDARY' }, admission, metadata);

    const midRun = registry.swap({ domain: 'coding-agent', newAdapterRef: 'a2', timing: 'MID_RUN' }, admission, { ...metadata, adapterRef: 'a2' });
    expect(midRun.allowed).toBe(false);
    expect(registry.getActive('coding-agent')).toBe('a1');
  });
});
