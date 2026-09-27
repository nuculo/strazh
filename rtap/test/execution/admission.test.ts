import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../../src/laws/index.js';
import { evaluatePhase5Admission, CURRENT_EXTRA_EVIDENCE } from '../../src/execution/admission.js';

describe('evaluatePhase5Admission', () => {
  it('reports all fourteen §15 criteria', async () => {
    const report = await evaluatePhase5Admission(buildRegistry());
    expect(report.criteria).toHaveLength(14);
    expect(report.criteria.map((c) => c.id)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('the twelve purely law-backed criteria (1, 3-10, 13, 14) are all MET given the current, fully-implemented law set', async () => {
    // Criterion 2 is deliberately excluded here even though promptfooWiredToHardening
    // is now true by default — it is still not purely law-backed, since flipping the
    // extra-evidence flag to false (the next test) must be able to fail it regardless
    // of what any law says. Criterion 12 is excluded for the same reason. Criteria 13
    // and 14 joined this group once a real law existed to check each against
    // (redteam.platform/runbook-covers-unknown-effect-outcome and
    // redteam.execution/rollback-disables-authorization-not-fencing, respectively).
    const report = await evaluatePhase5Admission(buildRegistry());
    const purelyLawBacked = report.criteria.filter((c) => c.id !== 2 && c.id !== 12);
    const notMet = purelyLawBacked.filter((c) => c.status !== 'MET');
    expect(notMet, JSON.stringify(notMet, null, 2)).toEqual([]);
  });

  it('is now honestly admissible overall — all fourteen §15 criteria are MET given the real current state of this repo', async () => {
    const report = await evaluatePhase5Admission(buildRegistry());
    const notMet = report.criteria.filter((c) => c.status !== 'MET');
    expect(notMet, JSON.stringify(notMet, null, 2)).toEqual([]);
    expect(report.admissible).toBe(true);
  });

  it('criteria 2 and 12 are MET under the real default evidence — a real production caller (src/worker/) exists, not just a test slice', async () => {
    const report = await evaluatePhase5Admission(buildRegistry());
    expect(report.criteria.find((c) => c.id === 2)!.status).toBe('MET');
    expect(report.criteria.find((c) => c.id === 12)!.status).toBe('MET');
  });

  it('criterion 2 requires both the law holding and adapters actually being wired — the law alone is not sufficient', async () => {
    const report = await evaluatePhase5Admission(buildRegistry(), { ...CURRENT_EXTRA_EVIDENCE, promptfooWiredToHardening: false });
    const criterion2 = report.criteria.find((c) => c.id === 2)!;
    expect(criterion2.status).toBe('NOT_MET');
  });

  it('flipping every piece of extra evidence to false makes the report inadmissible (proving the suite is not hardcoded to pass)', async () => {
    const report = await evaluatePhase5Admission(buildRegistry(), {
      crashMatrixRunsInCi: false,
      promptfooWiredToHardening: false,
    });
    expect(report.admissible).toBe(false);
    // Criterion 13 is not in this list on purpose — it no longer takes extraEvidence
    // at all, so there is nothing left to flip false for it. It stays MET here
    // because RUNBOOK.md genuinely still covers UNKNOWN_EFFECT_OUTCOME, not because
    // this test forgot to disable it.
    expect(report.criteria.filter((c) => c.status !== 'MET').map((c) => c.id)).toEqual([2, 11, 12]);
  });
});
