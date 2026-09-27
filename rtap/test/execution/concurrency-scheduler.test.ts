import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { ConcurrencyScheduler } from '../../src/execution/concurrency-scheduler.js';
import type { ConcurrencyDeclaration } from '../../src/execution/concurrency.js';

function declaration(overrides: Partial<ConcurrencyDeclaration> = {}): ConcurrencyDeclaration {
  return { concurrencyClass: 'TARGET_SERIAL', resourceKeys: ['target-1'], maxInFlight: null, supportsCancellation: true, destructive: false, rateLimitScope: null, ...overrides };
}

describe('ConcurrencyScheduler.reserve', () => {
  it('grants a reservation against an empty barrier', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const result = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration()] });
    expect(result.reserved).toBe(true);
  });

  it('rejects a TARGET_SERIAL request on a resource another active reservation holds', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration({ resourceKeys: ['target-1'] })] });
    const result = scheduler.reserve({ campaignId: 'c2', executionAttemptId: 'a2', declarations: [declaration({ resourceKeys: ['target-1'] })] });
    expect(result).toMatchObject({ reserved: false, reason: 'CONFLICT' });
  });

  it('grants two READ_ONLY_PARALLEL reservations on the same resource when unbounded', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const a = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration({ concurrencyClass: 'READ_ONLY_PARALLEL', maxInFlight: null })] });
    const b = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a2', declarations: [declaration({ concurrencyClass: 'READ_ONLY_PARALLEL', maxInFlight: null })] });
    expect(a.reserved).toBe(true);
    expect(b.reserved).toBe(true);
  });

  it('enforces maxInFlight for READ_ONLY_PARALLEL on a shared resource key', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const decl = declaration({ concurrencyClass: 'READ_ONLY_PARALLEL', resourceKeys: ['r1'], maxInFlight: 2 });
    const a = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [decl] });
    const b = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a2', declarations: [decl] });
    const c = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a3', declarations: [decl] });
    expect(a.reserved).toBe(true);
    expect(b.reserved).toBe(true);
    expect(c).toMatchObject({ reserved: false, reason: 'READ_ONLY_PARALLEL_LIMIT_EXCEEDED' });
  });

  it('releasing a reservation allows a previously-conflicting request to be granted', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const first = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration({ resourceKeys: ['r1'] })] });
    expect(first.reserved).toBe(true);
    if (!first.reserved) return;

    const blocked = scheduler.reserve({ campaignId: 'c2', executionAttemptId: 'a2', declarations: [declaration({ resourceKeys: ['r1'] })] });
    expect(blocked.reserved).toBe(false);

    scheduler.release(first.reservation.reservationId);
    const afterRelease = scheduler.reserve({ campaignId: 'c2', executionAttemptId: 'a2', declarations: [declaration({ resourceKeys: ['r1'] })] });
    expect(afterRelease.reserved).toBe(true);
  });

  it('combines multiple declarations to the strictest effective class and the union of resource keys', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const combined = scheduler.reserve({
      campaignId: 'c1',
      executionAttemptId: 'a1',
      declarations: [declaration({ concurrencyClass: 'READ_ONLY_PARALLEL', resourceKeys: ['r1'] }), declaration({ concurrencyClass: 'CAMPAIGN_SERIAL', resourceKeys: ['r2'] })],
    });
    expect(combined.reserved).toBe(true);
    if (!combined.reserved) return;
    expect(combined.reservation.concurrencyClass).toBe('CAMPAIGN_SERIAL');
    expect([...combined.reservation.resourceKeys].sort()).toEqual(['r1', 'r2']);

    // Now that the effective class is CAMPAIGN_SERIAL for campaign c1, nothing else in c1 may reserve.
    const blocked = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a2', declarations: [declaration({ concurrencyClass: 'READ_ONLY_PARALLEL', resourceKeys: ['r9'] })] });
    expect(blocked.reserved).toBe(false);
  });

  it('an EXCLUSIVE request requires an empty barrier, and once granted blocks everything else', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration({ concurrencyClass: 'READ_ONLY_PARALLEL', resourceKeys: ['r1'] })] });
    const exclusive = scheduler.reserve({ campaignId: 'c2', executionAttemptId: 'a2', declarations: [declaration({ concurrencyClass: 'EXCLUSIVE', resourceKeys: [] })] });
    expect(exclusive).toMatchObject({ reserved: false, reason: 'CONFLICT' });
  });

  it('activeReservations() excludes released reservations', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const a = scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration({ resourceKeys: ['r1'] })] });
    expect(a.reserved).toBe(true);
    if (!a.reserved) return;
    expect(scheduler.activeReservations()).toHaveLength(1);
    scheduler.release(a.reservation.reservationId);
    expect(scheduler.activeReservations()).toHaveLength(0);
  });
});

describe('ConcurrencyScheduler.probe (грань №19)', () => {
  it('reports wouldReserve:true against an empty barrier, without creating anything', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    const result = scheduler.probe({ campaignId: 'c1', declarations: [declaration()] });
    expect(result.wouldReserve).toBe(true);
    expect(scheduler.activeReservations()).toHaveLength(0);
  });

  it('reports the same CONFLICT refusal reserve() would give, without creating anything', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'a1', declarations: [declaration({ resourceKeys: ['target-1'] })] });
    const result = scheduler.probe({ campaignId: 'c2', declarations: [declaration({ resourceKeys: ['target-1'] })] });
    expect(result).toMatchObject({ wouldReserve: false, reason: 'CONFLICT' });
    expect(scheduler.activeReservations()).toHaveLength(1); // only the original holder, probe created nothing
  });

  it('agrees with a real reserve() call on the identical request', () => {
    const scheduler = new ConcurrencyScheduler(openInMemoryDatabase());
    scheduler.reserve({ campaignId: 'c1', executionAttemptId: 'holder', declarations: [declaration({ resourceKeys: ['r1'] })] });
    const request = { campaignId: 'c1', declarations: [declaration({ resourceKeys: ['r1'] })] };

    const probed = scheduler.probe(request);
    const reserved = scheduler.reserve({ ...request, executionAttemptId: 'probed' });
    expect(probed.wouldReserve).toBe(reserved.reserved);
  });
});
