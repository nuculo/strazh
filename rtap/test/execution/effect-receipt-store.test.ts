import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { EffectReceiptStore } from '../../src/execution/effect-receipt-store.js';
import type { EffectReceipt } from '../../src/execution/effect.js';

function receipt(overrides: Partial<EffectReceipt> = {}): EffectReceipt {
  return {
    effectId: 'effect-1',
    executionAttemptId: 'attempt-1',
    engineAdapterId: 'promptfoo',
    engineRequestId: 'req-1',
    idempotencyKey: null,
    capability: 'IDEMPOTENT_BY_KEY',
    startedAt: '2026-08-30T00:00:00.000Z',
    acknowledgedAt: null,
    externalReceiptRef: null,
    reconciliationToken: null,
    outcome: 'UNKNOWN',
    ...overrides,
  };
}

describe('EffectReceiptStore', () => {
  it('records and reads back a receipt by effectId', () => {
    const store = new EffectReceiptStore(openInMemoryDatabase());
    store.record(receipt());
    expect(store.get('effect-1')).toEqual(receipt());
  });

  it('reads back a receipt by executionAttemptId', () => {
    const store = new EffectReceiptStore(openInMemoryDatabase());
    store.record(receipt());
    expect(store.getByExecutionAttempt('attempt-1')).toEqual(receipt());
  });

  it('returns null for an unknown effectId or executionAttemptId', () => {
    const store = new EffectReceiptStore(openInMemoryDatabase());
    expect(store.get('no-such-effect')).toBeNull();
    expect(store.getByExecutionAttempt('no-such-attempt')).toBeNull();
  });

  it('updates outcome/acknowledgedAt/refs in place on a second record() for the same effectId, rather than duplicating', () => {
    const store = new EffectReceiptStore(openInMemoryDatabase());
    store.record(receipt({ outcome: 'UNKNOWN' }));
    store.record(receipt({ outcome: 'CONFIRMED', acknowledgedAt: '2026-08-30T00:05:00.000Z', externalReceiptRef: 'artifact:receipt-1' }));

    const updated = store.get('effect-1');
    expect(updated?.outcome).toBe('CONFIRMED');
    expect(updated?.acknowledgedAt).toBe('2026-08-30T00:05:00.000Z');
    expect(updated?.externalReceiptRef).toBe('artifact:receipt-1');
  });
});
