import { describe, expect, it } from 'vitest';
import { normalizeConcurrencyClass, reservationsConflict, strictestClass } from '../../src/execution/concurrency.js';

describe('normalizeConcurrencyClass', () => {
  it('normalizes UNKNOWN to EXCLUSIVE and leaves every other class unchanged', () => {
    expect(normalizeConcurrencyClass('UNKNOWN')).toBe('EXCLUSIVE');
    for (const c of ['READ_ONLY_PARALLEL', 'TARGET_SERIAL', 'CAMPAIGN_SERIAL', 'EXCLUSIVE'] as const) {
      expect(normalizeConcurrencyClass(c)).toBe(c);
    }
  });
});

describe('strictestClass', () => {
  it('picks EXCLUSIVE over anything else', () => {
    expect(strictestClass(['READ_ONLY_PARALLEL', 'EXCLUSIVE', 'TARGET_SERIAL'])).toBe('EXCLUSIVE');
  });

  it('picks CAMPAIGN_SERIAL over TARGET_SERIAL and READ_ONLY_PARALLEL', () => {
    expect(strictestClass(['READ_ONLY_PARALLEL', 'TARGET_SERIAL', 'CAMPAIGN_SERIAL'])).toBe('CAMPAIGN_SERIAL');
  });

  it('treats UNKNOWN as EXCLUSIVE when combining', () => {
    expect(strictestClass(['READ_ONLY_PARALLEL', 'UNKNOWN'])).toBe('EXCLUSIVE');
  });

  it('returns the single class unchanged for one declaration', () => {
    expect(strictestClass(['TARGET_SERIAL'])).toBe('TARGET_SERIAL');
  });

  it('throws for an empty declaration list', () => {
    expect(() => strictestClass([])).toThrow();
  });
});

describe('reservationsConflict', () => {
  it('is symmetric', () => {
    const a = { campaignId: 'c1', concurrencyClass: 'TARGET_SERIAL' as const, resourceKeys: ['r1'] };
    const b = { campaignId: 'c2', concurrencyClass: 'READ_ONLY_PARALLEL' as const, resourceKeys: ['r1'] };
    expect(reservationsConflict(a, b)).toBe(reservationsConflict(b, a));
  });

  it('two READ_ONLY_PARALLEL reservations never conflict, even sharing a resource key', () => {
    const a = { campaignId: 'c1', concurrencyClass: 'READ_ONLY_PARALLEL' as const, resourceKeys: ['r1'] };
    const b = { campaignId: 'c2', concurrencyClass: 'READ_ONLY_PARALLEL' as const, resourceKeys: ['r1'] };
    expect(reservationsConflict(a, b)).toBe(false);
  });

  it('TARGET_SERIAL conflicts with anything sharing a resource key, regardless of the other class', () => {
    const serial = { campaignId: 'c1', concurrencyClass: 'TARGET_SERIAL' as const, resourceKeys: ['r1'] };
    const parallel = { campaignId: 'c2', concurrencyClass: 'READ_ONLY_PARALLEL' as const, resourceKeys: ['r1'] };
    expect(reservationsConflict(serial, parallel)).toBe(true);
  });

  it('TARGET_SERIAL does not conflict when resource keys do not overlap', () => {
    const a = { campaignId: 'c1', concurrencyClass: 'TARGET_SERIAL' as const, resourceKeys: ['r1'] };
    const b = { campaignId: 'c1', concurrencyClass: 'TARGET_SERIAL' as const, resourceKeys: ['r2'] };
    expect(reservationsConflict(a, b)).toBe(false);
  });

  it('CAMPAIGN_SERIAL conflicts with anything in the same campaign, regardless of resource keys or the other class', () => {
    const serial = { campaignId: 'c1', concurrencyClass: 'CAMPAIGN_SERIAL' as const, resourceKeys: ['r1'] };
    const parallel = { campaignId: 'c1', concurrencyClass: 'READ_ONLY_PARALLEL' as const, resourceKeys: ['r2'] };
    expect(reservationsConflict(serial, parallel)).toBe(true);
  });

  it('CAMPAIGN_SERIAL does not conflict across different campaigns', () => {
    const a = { campaignId: 'c1', concurrencyClass: 'CAMPAIGN_SERIAL' as const, resourceKeys: ['r1'] };
    const b = { campaignId: 'c2', concurrencyClass: 'CAMPAIGN_SERIAL' as const, resourceKeys: ['r1'] };
    expect(reservationsConflict(a, b)).toBe(false);
  });

  it('EXCLUSIVE (and UNKNOWN, normalized) conflicts with everything, including another EXCLUSIVE', () => {
    const exclusive = { campaignId: 'c1', concurrencyClass: 'EXCLUSIVE' as const, resourceKeys: [] };
    const unrelated = { campaignId: 'c2', concurrencyClass: 'READ_ONLY_PARALLEL' as const, resourceKeys: ['r9'] };
    expect(reservationsConflict(exclusive, unrelated)).toBe(true);
    expect(reservationsConflict(exclusive, exclusive)).toBe(true);
    const unknown = { campaignId: 'c3', concurrencyClass: 'UNKNOWN' as const, resourceKeys: [] };
    expect(reservationsConflict(unknown, unrelated)).toBe(true);
  });
});
