import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../src/db/connection.js';
import { RunStepStore } from '../src/runsteps/store.js';

function store() {
  return new RunStepStore(openInMemoryDatabase());
}

describe('RunStepStore', () => {
  it('enqueues a new step as PENDING', () => {
    const s = store();
    const { step, deduped } = s.enqueue('run-1', 'probe-1', { probeId: 'probe-1' });
    expect(deduped).toBe(false);
    expect(step.status).toBe('PENDING');
    expect(step.attempt).toBe(0);
  });

  it('is idempotent: re-enqueuing the same key returns the same step, does not duplicate', () => {
    const s = store();
    const first = s.enqueue('run-1', 'probe-1', { a: 1 });
    const second = s.enqueue('run-1', 'probe-1', { a: 1 });
    expect(second.deduped).toBe(true);
    expect(second.step.id).toBe(first.step.id);
    expect(s.listByAssessmentRun('run-1')).toHaveLength(1);
  });

  it('runs the full lifecycle: PENDING -> LEASED -> RUNNING -> SUCCEEDED', () => {
    const s = store();
    s.enqueue('run-1', 'probe-1', {});
    const leased = s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 5000 });
    expect(leased?.status).toBe('LEASED');
    expect(leased?.attempt).toBe(1);

    const running = s.markRunning(leased!.id, 'worker-a');
    expect(running.status).toBe('RUNNING');

    const done = s.complete(running.id, 'worker-a');
    expect(done.status).toBe('SUCCEEDED');
    expect(done.committedAt).not.toBeNull();
  });

  it('lease() returns null when there is nothing to claim', () => {
    const s = store();
    expect(s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 5000 })).toBeNull();
  });

  it('does not lease a step someone else already holds a live lease on', () => {
    const s = store();
    s.enqueue('run-1', 'probe-1', {});
    s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 60_000 });
    expect(s.lease('run-1', { owner: 'worker-b', leaseDurationMs: 60_000 })).toBeNull();
  });

  it('reclaims a step whose lease has expired', () => {
    const s = store();
    s.enqueue('run-1', 'probe-1', {});
    const now = new Date('2026-08-30T00:00:00.000Z');
    s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 1000, now: () => now });

    const later = new Date(now.getTime() + 2000);
    const reclaimed = s.lease('run-1', { owner: 'worker-b', leaseDurationMs: 5000, now: () => later });
    expect(reclaimed?.leaseOwner).toBe('worker-b');
    expect(reclaimed?.attempt).toBe(2);
  });

  it('leaseGeneration is a monotonic fencing token, distinct from attempt but incrementing on the same triggers (EXECUTION_SAFETY_RECOVERY.md §4.1)', () => {
    const s = store();
    const { step: fresh } = s.enqueue('run-1', 'probe-1', {});
    expect(fresh.leaseGeneration).toBe(0);

    const now = new Date('2026-08-30T00:00:00.000Z');
    const first = s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 1000, now: () => now });
    expect(first?.leaseGeneration).toBe(1);

    const later = new Date(now.getTime() + 2000);
    const reclaimed = s.lease('run-1', { owner: 'worker-b', leaseDurationMs: 5000, now: () => later });
    expect(reclaimed?.leaseGeneration).toBe(2);
    expect(reclaimed?.attempt).toBe(2); // same trigger as leaseGeneration here, but a conceptually separate field
  });

  it('fail() records the error and marks the step FAILED', () => {
    const s = store();
    s.enqueue('run-1', 'probe-1', {});
    const leased = s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 5000 })!;
    s.markRunning(leased.id, 'worker-a');
    const failed = s.fail(leased.id, 'worker-a', 'provider timed out');
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toBe('provider timed out');
  });

  it('refuses to complete a step held by a different owner', () => {
    const s = store();
    s.enqueue('run-1', 'probe-1', {});
    const leased = s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 5000 })!;
    s.markRunning(leased.id, 'worker-a');
    expect(() => s.complete(leased.id, 'worker-b')).toThrow();
  });

  describe('peekLeasable() and targeted lease({stepId}) (грань №19)', () => {
    it('peekLeasable() returns the same candidate lease() would claim, without mutating anything', () => {
      const s = store();
      s.enqueue('run-1', 'probe-1', {});
      const peeked = s.peekLeasable('run-1');
      expect(peeked?.status).toBe('PENDING'); // unchanged — peek never leases
      const leased = s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 5000 });
      expect(leased?.id).toBe(peeked?.id);
    });

    it('peekLeasable() returns null when there is nothing to claim', () => {
      const s = store();
      expect(s.peekLeasable('run-1')).toBeNull();
    });

    it('excludeIds skips the excluded candidate and returns the next-oldest one instead', () => {
      const s = store();
      const { step: first } = s.enqueue('run-1', 'probe-1', {}, new Date(0));
      const { step: second } = s.enqueue('run-1', 'probe-2', {}, new Date(1000));
      const peeked = s.peekLeasable('run-1');
      expect(peeked?.id).toBe(first.id);
      const excluded = s.peekLeasable('run-1', { excludeIds: [first.id] });
      expect(excluded?.id).toBe(second.id);
    });

    it('lease({stepId}) claims exactly that step, not whichever is oldest', () => {
      const s = store();
      s.enqueue('run-1', 'probe-1', {}, new Date(0));
      const { step: second } = s.enqueue('run-1', 'probe-2', {}, new Date(1000));
      const leased = s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 5000, stepId: second.id });
      expect(leased?.id).toBe(second.id);
    });

    it('lease({stepId}) returns null if that specific step is not currently leasable (already leased, live)', () => {
      const s = store();
      const { step } = s.enqueue('run-1', 'probe-1', {});
      s.lease('run-1', { owner: 'worker-a', leaseDurationMs: 60_000, stepId: step.id });
      expect(s.lease('run-1', { owner: 'worker-b', leaseDurationMs: 60_000, stepId: step.id })).toBeNull();
    });
  });

  describe('campaignId/targetId identity (ARCH_CLAUDE_TRANSFER.md §2.5)', () => {
    it('is null on both fields when no identity is supplied — every caller that predates this', () => {
      const s = store();
      const { step } = s.enqueue('run-1', 'probe-1', {});
      expect(step.campaignId).toBeNull();
      expect(step.targetId).toBeNull();
    });

    it('is populated verbatim when identity is supplied', () => {
      const s = store();
      const { step } = s.enqueue('run-1', 'probe-1', {}, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
      expect(step.campaignId).toBe('campaign-1');
      expect(step.targetId).toBe('target-1');
    });

    it('survives a get() round-trip, not just the enqueue() return value', () => {
      const s = store();
      const { step } = s.enqueue('run-1', 'probe-1', {}, new Date(), { campaignId: 'campaign-1', targetId: 'target-1' });
      const reloaded = s.get(step.id);
      expect(reloaded?.campaignId).toBe('campaign-1');
      expect(reloaded?.targetId).toBe('target-1');
    });
  });
});
