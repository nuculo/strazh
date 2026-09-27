import { describe, expect, it } from 'vitest';
import { replay } from '../../src/world/replay.js';
import { targetProbeKey } from '../../src/features/history-view.js';
import { eventForScheduledProbe, eventForObservation } from '../../src/pipeline/observation-event.js';
import { buildAssessmentReport, buildJsonReport } from '../../src/pipeline/report.js';
import { validate } from '../../src/schemas/index.js';
import type { CampaignEventEnvelope } from '../../src/events/store.js';

let sequence = 0;
function seal(input: ReturnType<typeof eventForScheduledProbe>): CampaignEventEnvelope {
  return { ...input, sequence: sequence++, committedAt: new Date(0).toISOString() } as unknown as CampaignEventEnvelope;
}
function reset() {
  sequence = 0;
}

const ctx = { campaignId: 'campaign-1', assessmentRunId: 'run-1', occurredAt: '2026-08-30T00:00:00.000Z' };

describe('eventForScheduledProbe — the coverage denominator', () => {
  it('validates against rtap:campaign-event with no schema change: ProbeScheduled was already in the enum with no producer', () => {
    const event = eventForScheduledProbe({ targetId: 'target-1', probeId: 'sql-injection:base64' }, { ...ctx, eventId: 'evt-sched-1' });
    expect(event.eventType).toBe('ProbeScheduled');
    expect(event.sourceObservationIds).toEqual([]); // no Observation exists yet, and the schema sets no minItems
    const check = validate('rtap:campaign-event', { ...event, sequence: 0, committedAt: ctx.occurredAt });
    expect(check.errors ?? []).toEqual([]);
    expect(check.valid).toBe(true);
  });

  it('a scheduled probe enters the world as intent and carries no verdict — so it derives no Finding', () => {
    reset();
    const events = [seal(eventForScheduledProbe({ targetId: 'target-1', probeId: 'sql-injection:base64' }, { ...ctx, eventId: 'evt-1' }))];
    const world = replay(events, 'campaign-1').world;

    expect(world.scheduledUnresolved.has(targetProbeKey('target-1', 'sql-injection:base64'))).toBe(true);
    expect([...world.entities.values()].some((e) => e.type === 'Finding')).toBe(false);
    expect([...world.entities.values()].some((e) => e.type === 'Target')).toBe(true);
  });

  it('each of the four resolving verdicts clears its scheduled probe — including ERROR, since a known failure is an outcome', () => {
    for (const verdict of ['VULNERABLE', 'RESISTANT', 'UNVERIFIED', 'ERROR'] as const) {
      reset();
      const events = [
        seal(eventForScheduledProbe({ targetId: 'target-1', probeId: 'probe-1' }, { ...ctx, eventId: 'evt-sched' })),
        seal(eventForObservation({ id: `obs-${verdict}`, verdict, targetId: 'target-1', probeId: 'probe-1' }, ctx) as never),
      ];
      const world = replay(events, 'campaign-1').world;
      expect(world.scheduledUnresolved.size, `${verdict} should resolve its scheduled probe`).toBe(0);
    }
  });

  it('the exact defect: an adapter that dies mid-sweep is no longer indistinguishable from a clean run', () => {
    reset();
    const scheduled = Array.from({ length: 5 }, (_, i) => ({ targetId: 'target-1', probeId: `probe-${i}` }));
    const events = [
      ...scheduled.map((p, i) => seal(eventForScheduledProbe(p, { ...ctx, eventId: `evt-sched-${i}` }))),
      // Only the first two ever ran, and both found nothing.
      seal(eventForObservation({ id: 'obs-0', verdict: 'RESISTANT', targetId: 'target-1', probeId: 'probe-0' }, ctx) as never),
      seal(eventForObservation({ id: 'obs-1', verdict: 'RESISTANT', targetId: 'target-1', probeId: 'probe-1' }, ctx) as never),
    ];
    const world = replay(events, 'campaign-1').world;

    // Before this change the report below was indistinguishable from a clean sweep of 5.
    const result = buildAssessmentReport({
      assessmentRunId: 'run-1',
      generatedAt: ctx.occurredAt,
      observations: [],
      findings: [],
      coverage: { scheduled: scheduled.length, unresolved: [...world.scheduledUnresolved] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('UNRESOLVED_COVERAGE');
    expect(result.report.coverage.scheduled).toBe(5);
    expect(result.report.coverage.resolved).toBe(2);
    expect(result.report.coverage.unresolved).toHaveLength(3);
    // The partial data is still readable — refusal is about the claim, not the data.
    expect(result.report.summary.totalFindings).toBe(0);
  });

  it('omitting coverage is UNKNOWN, never COMPLETE — absence of information must not read as proof', () => {
    const result = buildAssessmentReport({ assessmentRunId: 'run-1', generatedAt: ctx.occurredAt, observations: [], findings: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('UNKNOWN_COVERAGE');
    expect(result.report.coverage.status).toBe('UNKNOWN');
    expect(result.report.coverage.scheduled).toBeNull();
  });

  it('buildJsonReport() stays total for every existing caller, but always carries a coverage block', () => {
    const report = buildJsonReport({ assessmentRunId: 'run-1', generatedAt: ctx.occurredAt, observations: [], findings: [] });
    expect(report.coverage.status).toBe('UNKNOWN');
    expect(report.summary.totalObservations).toBe(0);
  });

  it('a fully resolved run is accepted and marked COMPLETE', () => {
    reset();
    const events = [
      seal(eventForScheduledProbe({ targetId: 'target-1', probeId: 'probe-0' }, { ...ctx, eventId: 'evt-sched-0' })),
      seal(eventForObservation({ id: 'obs-0', verdict: 'RESISTANT', targetId: 'target-1', probeId: 'probe-0' }, ctx) as never),
    ];
    const world = replay(events, 'campaign-1').world;

    const result = buildAssessmentReport({
      assessmentRunId: 'run-1',
      generatedAt: ctx.occurredAt,
      observations: [],
      findings: [],
      coverage: { scheduled: 1, unresolved: [...world.scheduledUnresolved] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.coverage).toEqual({ status: 'COMPLETE', scheduled: 1, resolved: 1, unresolved: [] });
  });
});
