import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { AssessmentRunStore, AssessmentRunCampaignMismatchError } from '../../src/planner/assessment-run-store.js';

describe('AssessmentRunStore (грань №20)', () => {
  it('start() creates a new row, HEALTHY, with no ever-degraded/acceptance marks', () => {
    const store = new AssessmentRunStore(openInMemoryDatabase());
    const record = store.start('run-1', 'campaign-1', new Date(0));
    expect(record.campaignId).toBe('campaign-1');
    expect(record.intelligenceStatus).toBe('HEALTHY');
    expect(record.everDegradedAt).toBeNull();
    expect(record.coverageAcceptance).toBeNull();
    expect(record.acceptedAt).toBeNull();
  });

  it('start() is idempotent by campaign — a repeat call returns the same row, does not refresh startedAt', () => {
    const db = openInMemoryDatabase();
    const store = new AssessmentRunStore(db);
    const first = store.start('run-1', 'campaign-1', new Date(0));
    const second = store.start('run-1', 'campaign-1', new Date(60_000));
    expect(second).toEqual(first);

    const count = (db.prepare(`SELECT COUNT(*) as n FROM assessment_runs`).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('start() with a different campaignId for an existing assessmentRunId throws AssessmentRunCampaignMismatchError', () => {
    const store = new AssessmentRunStore(openInMemoryDatabase());
    store.start('run-1', 'campaign-1', new Date(0));
    expect(() => store.start('run-1', 'campaign-2', new Date(1000))).toThrow(AssessmentRunCampaignMismatchError);
    expect(store.get('run-1')?.campaignId).toBe('campaign-1');
  });

  it('get() returns null for an unstarted assessmentRunId', () => {
    const store = new AssessmentRunStore(openInMemoryDatabase());
    expect(store.get('never-started')).toBeNull();
  });

  describe('recordIntelligenceStatus()', () => {
    it('is a safe no-op against an unstarted run — no row created, never throws', () => {
      const store = new AssessmentRunStore(openInMemoryDatabase());
      const result = store.recordIntelligenceStatus('run-1', 'DEGRADED', new Date(0));
      expect(result).toEqual({ recorded: false, record: null });
      expect(store.get('run-1')).toBeNull();
    });

    it('overwrites intelligence_status on every call — non-monotonic, HEALTHY can follow DEGRADED', () => {
      const store = new AssessmentRunStore(openInMemoryDatabase());
      store.start('run-1', 'campaign-1', new Date(0));

      const degraded = store.recordIntelligenceStatus('run-1', 'DEGRADED', new Date(1000));
      expect(degraded.record?.intelligenceStatus).toBe('DEGRADED');

      const healthy = store.recordIntelligenceStatus('run-1', 'HEALTHY', new Date(2000));
      expect(healthy.record?.intelligenceStatus).toBe('HEALTHY');
      expect(healthy.record?.intelligenceStatusUpdatedAt).toBe(new Date(2000).toISOString());
    });

    it('everDegradedAt is stamped once, on the first DEGRADED write, and survives a later HEALTHY write', () => {
      const store = new AssessmentRunStore(openInMemoryDatabase());
      store.start('run-1', 'campaign-1', new Date(0));

      const firstDegraded = store.recordIntelligenceStatus('run-1', 'DEGRADED', new Date(1000));
      expect(firstDegraded.record?.everDegradedAt).toBe(new Date(1000).toISOString());

      store.recordIntelligenceStatus('run-1', 'HEALTHY', new Date(2000));
      const secondDegraded = store.recordIntelligenceStatus('run-1', 'DEGRADED', new Date(3000));
      // Still the FIRST timestamp, not the second DEGRADED write's.
      expect(secondDegraded.record?.everDegradedAt).toBe(new Date(1000).toISOString());

      const afterRecovery = store.recordIntelligenceStatus('run-1', 'HEALTHY', new Date(4000));
      expect(afterRecovery.record?.intelligenceStatus).toBe('HEALTHY');
      expect(afterRecovery.record?.everDegradedAt).toBe(new Date(1000).toISOString());
    });
  });

  describe('acceptCoverage()', () => {
    it('reports NOT_FOUND against an unstarted run, without creating a row', () => {
      const store = new AssessmentRunStore(openInMemoryDatabase());
      const result = store.acceptCoverage('run-1', 'looks fine', 'operator-1', new Date(0));
      expect(result).toEqual({ accepted: false, reason: 'NOT_FOUND' });
      expect(store.get('run-1')).toBeNull();
    });

    it('claims exactly once — a second call reports ALREADY_ACCEPTED with the original note/operator, not overwritten', () => {
      const store = new AssessmentRunStore(openInMemoryDatabase());
      store.start('run-1', 'campaign-1', new Date(0));

      const first = store.acceptCoverage('run-1', 'first note', 'operator-a', new Date(1000));
      expect(first.accepted).toBe(true);
      if (!first.accepted) return;
      expect(first.record.coverageAcceptance).toBe('first note');
      expect(first.record.acceptedBy).toBe('operator-a');

      const second = store.acceptCoverage('run-1', 'second note', 'operator-b', new Date(2000));
      expect(second.accepted).toBe(false);
      if (second.accepted) return;
      expect(second.reason).toBe('ALREADY_ACCEPTED');
      if (second.reason !== 'ALREADY_ACCEPTED') return;
      expect(second.record.coverageAcceptance).toBe('first note');
      expect(second.record.acceptedBy).toBe('operator-a');
    });

    it('is not gated on intelligenceStatus — a HEALTHY run can be accepted too', () => {
      const store = new AssessmentRunStore(openInMemoryDatabase());
      store.start('run-1', 'campaign-1', new Date(0));
      const result = store.acceptCoverage('run-1', 'reviewed proactively', 'operator-1', new Date(1000));
      expect(result.accepted).toBe(true);
    });
  });

  it('listAll() returns every row, oldest first', () => {
    const store = new AssessmentRunStore(openInMemoryDatabase());
    store.start('run-b', 'campaign-1', new Date(2000));
    store.start('run-a', 'campaign-1', new Date(1000));
    expect(store.listAll().map((r) => r.assessmentRunId)).toEqual(['run-a', 'run-b']);
  });

  it('keeps different assessmentRunIds as separate rows', () => {
    const store = new AssessmentRunStore(openInMemoryDatabase());
    store.start('run-a', 'campaign-1', new Date(0));
    store.start('run-b', 'campaign-2', new Date(0));
    expect(store.get('run-a')?.campaignId).toBe('campaign-1');
    expect(store.get('run-b')?.campaignId).toBe('campaign-2');
  });
});
