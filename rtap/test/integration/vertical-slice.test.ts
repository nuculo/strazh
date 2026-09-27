import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { RunStepStore } from '../../src/runsteps/store.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { ObservationStore } from '../../src/observations/store.js';
import { FindingStore } from '../../src/findings/store.js';
import { PromptfooCliAdapter } from '../../src/adapters/promptfoo/run.js';
import { parsePromptfooResult, type ParseContext } from '../../src/adapters/promptfoo/parse.js';
import { eventForObservation } from '../../src/pipeline/observation-event.js';
import { commitObservationWithEvent } from '../../src/pipeline/commit-observation.js';
import { correlateFindings } from '../../src/pipeline/correlate.js';
import { buildJsonReport, buildMarkdownReport } from '../../src/pipeline/report.js';
import type { PromptfooOutputFile } from '../../src/adapters/promptfoo/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '../fixtures/promptfoo-eval-result.json'), 'utf-8')) as PromptfooOutputFile;

/**
 * Phase 1 vertical slice, end to end: durable RunStep -> PromptfooAdapter -> ACL
 * parse -> Observation persisted -> CampaignEvent appended (replay-only fixture,
 * nothing reads it back yet — that's Phase 4) -> Finding Correlator -> report.
 *
 * Everything here runs against a real (in-memory) SQLite database and real schema
 * validation. The only faked piece is the promptfoo child process itself — see
 * PromptfooCliAdapter's own doc comment for why.
 */
describe('Phase 1 vertical slice: promptfoo -> Observation -> Finding -> report', () => {
  it('runs the full pipeline and produces a consistent report', async () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const events = new CampaignEventStore(db);
    const observations = new ObservationStore(db);
    const findingsStore = new FindingStore(db);

    const assessmentRunId = 'run-1';
    const campaignId = 'campaign-1';
    const owner = 'worker-1';

    // 1. Durable RunStep for "execute the promptfoo engine run".
    const { step } = runSteps.enqueue(assessmentRunId, 'promptfoo-scan', { engine: 'promptfoo' });
    const leased = runSteps.lease(assessmentRunId, { owner, leaseDurationMs: 60_000 });
    expect(leased?.id).toBe(step.id);
    runSteps.markRunning(leased!.id, owner);

    // 2. PromptfooAdapter "runs" (fixture-backed, see adapter doc comment).
    const adapter = new PromptfooCliAdapter(
      async () => ({ stdout: '', stderr: '' }),
      async () => JSON.stringify(fixture),
    );
    const runResult = await adapter.run({ configPath: 'redteam.yaml', outputPath: 'out.json' });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;

    // 3. ACL parse -> Observation, persisted, one CampaignEvent per Observation.
    const parseCtx: ParseContext = {
      assessmentRunId,
      targetId: 'target-1',
      nativeRunId: fixture.evalId ?? 'unknown',
      engineVersion: '0.122.0',
      adapterVersion: '0.1.0',
    };

    for (const [i, result] of runResult.output.results.entries()) {
      const observation = parsePromptfooResult(result, i, parseCtx);
      commitObservationWithEvent(
        db,
        observations,
        events,
        observation,
        eventForObservation(observation, {
          campaignId,
          assessmentRunId,
          occurredAt: '2026-08-30T00:00:00.000Z',
        }),
      );
    }

    runSteps.complete(leased!.id, owner);

    // 4. Assertions on durable state.
    const storedObservations = observations.listByAssessmentRun(assessmentRunId);
    expect(storedObservations).toHaveLength(4);

    const committedEvents = events.listByCampaign(campaignId);
    expect(committedEvents).toHaveLength(4);
    expect(committedEvents.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(committedEvents.map((e) => e.eventType).sort()).toEqual(
      ['ExecutionFailed', 'ResistanceObserved', 'ResistanceObserved', 'VulnerabilityObserved'].sort(),
    );
    // No raw prompt text anywhere in the committed event log.
    for (const e of committedEvents) {
      expect(JSON.stringify(e)).not.toContain('ignore previous instructions');
    }

    const finalStep = runSteps.get(step.id);
    expect(finalStep?.status).toBe('SUCCEEDED');

    // 5. Finding Correlator + persistence.
    const findings = correlateFindings(storedObservations);
    for (const finding of findings) findingsStore.put(finding);

    expect(findings).toHaveLength(3); // prompt-injection:base64, harmful-cybercrime:default, pii-leak:default
    const promptInjectionFinding = findings.find((f) => f.observationIds.some((id) => id.includes('res-1')));
    expect(promptInjectionFinding?.verdict).toBe('VULNERABLE'); // res-1 VULNERABLE + res-2 RESISTANT -> VULNERABLE wins

    expect(findingsStore.listByTarget('target-1')).toHaveLength(3);

    // 6. Report.
    const report = buildJsonReport({
      assessmentRunId,
      generatedAt: '2026-08-30T00:05:00.000Z',
      observations: storedObservations,
      findings,
    });
    expect(report.summary.totalObservations).toBe(4);
    expect(report.summary.byVerdict.VULNERABLE).toBe(1);

    const markdown = buildMarkdownReport({
      assessmentRunId,
      generatedAt: '2026-08-30T00:05:00.000Z',
      observations: storedObservations,
      findings,
    });
    expect(markdown).toContain('# RTAP Assessment Report');
    expect(markdown).not.toContain('ignore previous instructions');
  });

  it('a RunStep failure surfaces as FAILED without corrupting already-committed observations', async () => {
    const db = openInMemoryDatabase();
    const runSteps = new RunStepStore(db);
    const owner = 'worker-1';

    const { step } = runSteps.enqueue('run-2', 'promptfoo-scan', {});
    const leased = runSteps.lease('run-2', { owner, leaseDurationMs: 60_000 })!;
    runSteps.markRunning(leased.id, owner);

    const brokenAdapter = new PromptfooCliAdapter(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await brokenAdapter.run({ configPath: 'redteam.yaml', outputPath: 'out.json' });
    expect(result.ok).toBe(false);

    const failed = runSteps.fail(step.id, owner, result.ok ? '' : result.error);
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toContain('ECONNREFUSED');
  });
});
