import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ObservationStore } from '../../src/observations/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { commitObservationWithEvent } from '../../src/pipeline/commit-observation.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { parseDuoLlmRedteamReport, type ParseContext } from '../../src/adapters/duo-llm/parse.js';
import { DuoLlmCliAdapter } from '../../src/adapters/duo-llm/run.js';
import { replay } from '../../src/world/replay.js';
import type { DuoLlmRedteamReport } from '../../src/adapters/duo-llm/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '../fixtures/duo-llm-redteam-report.json'), 'utf-8')) as DuoLlmRedteamReport;

/**
 * Phase R vertical slice, two independent halves:
 *
 * 1. A real captured `duo-agents redteam` report — including its one genuinely
 *    graded failure (a reasoning-DoS hit) and its 28 ungraded "defaulting to pass"
 *    results — commits and replays through the *same* Phase 4 world reducer every
 *    other adapter uses, and every single one lands as ObservationUnverified. The
 *    real "vulnerability" the underlying tool found does not become VULNERABLE in
 *    RTAP, because `configIgnored: true` forces UNVERIFIED regardless of grade —
 *    that's the point of remediation not being done yet, not a bug in this test.
 * 2. `DuoLlmCliAdapter` refuses to run at all — the capability gate rejects before
 *    `execFn` is ever invoked, so no CampaignEvent can even be produced from a live
 *    invocation today.
 */
describe('Phase R vertical slice: duo LLM remediation (quarantine holds end-to-end)', () => {
  it('every duo-llm Observation — graded or not — replays into the world as UNVERIFIED, never VULNERABLE', () => {
    const db = openInMemoryDatabase();
    const observations = new ObservationStore(db);
    const events = new CampaignEventStore(db);

    const ctx: ParseContext = { assessmentRunId: 'run-1', targetId: 'target-chatbot', engineVersion: '0.1.0', adapterVersion: '0.1.0' };
    const parsed = parseDuoLlmRedteamReport(fixture, ctx);

    // The fixture really does contain a graded failure — proves this isn't vacuous.
    expect(fixture.results.some((r) => r.grade.pass === false)).toBe(true);

    for (const observation of parsed) {
      commitObservationWithEvent(
        db,
        observations,
        events,
        observation,
        eventForObservation(observation, { campaignId: 'campaign-llm-redteam', assessmentRunId: ctx.assessmentRunId, occurredAt: fixture.timestamp }),
      );
    }

    const allEvents = events.listByCampaign('campaign-llm-redteam');
    expect(allEvents).toHaveLength(fixture.results.length);
    expect(allEvents.every((e) => e.eventType === 'ObservationUnverified')).toBe(true);

    const result = replay(allEvents, 'campaign-llm-redteam');
    expect(result.stoppedAt).toBeNull();
    expect(result.world.entities.get('target-chatbot')).toMatchObject({ type: 'Target' });

    const distinctPlugins = new Set(fixture.results.map((r) => r.attack.plugin_id));
    const probeClasses = [...result.world.entities.values()].filter((e) => e.type === 'ProbeClass');
    expect(probeClasses.length).toBe(distinctPlugins.size);
  });

  it('DuoLlmCliAdapter never reaches a live process — capability gate rejects first, every time', async () => {
    let invoked = false;
    const adapter = new DuoLlmCliAdapter(async () => {
      invoked = true;
      return { stdout: JSON.stringify(fixture), stderr: '' };
    });
    const result = await adapter.run({ purpose: 'internal support chatbot', attacksPerPlugin: 5, outputPath: '/tmp/would-be-real-output.json' });
    expect(invoked).toBe(false);
    expect(result.ok).toBe(false);
  });
});
