import { describe, expect, it } from 'vitest';
import { decideRecovery, terminalReasonFor } from '../../src/execution/reconciliation.js';

describe('decideRecovery', () => {
  it('retries unconditionally when the effect is proven never to have started, regardless of capability', () => {
    for (const capability of ['IDEMPOTENT_BY_KEY', 'QUERYABLE_RECEIPT', 'COMPENSATABLE', 'AT_MOST_ONCE_UNPROVEN'] as const) {
      expect(decideRecovery({ effectStarted: false, capability }).action).toBe('RETRY_SAME_EFFECT');
    }
  });

  it('IDEMPOTENT_BY_KEY retries even when the effect start is ambiguous', () => {
    expect(decideRecovery({ effectStarted: null, capability: 'IDEMPOTENT_BY_KEY' }).action).toBe('RETRY_SAME_EFFECT');
    expect(decideRecovery({ effectStarted: true, capability: 'IDEMPOTENT_BY_KEY' }).action).toBe('RETRY_SAME_EFFECT');
  });

  it('COMPENSATABLE runs compensation rather than retrying or declaring unknown, on an unresolved outcome', () => {
    expect(decideRecovery({ effectStarted: null, capability: 'COMPENSATABLE' }).action).toBe('RUN_COMPENSATION');
  });

  it('AT_MOST_ONCE_UNPROVEN never auto-retries on an unresolved outcome', () => {
    expect(decideRecovery({ effectStarted: null, capability: 'AT_MOST_ONCE_UNPROVEN' }).action).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(decideRecovery({ effectStarted: true, capability: 'AT_MOST_ONCE_UNPROVEN' }).action).toBe('UNKNOWN_EFFECT_OUTCOME');
  });

  it('QUERYABLE_RECEIPT queries first when no query has been performed', () => {
    expect(decideRecovery({ effectStarted: null, capability: 'QUERYABLE_RECEIPT' }).action).toBe('QUERY_EXTERNAL_RECEIPT');
  });

  it('QUERYABLE_RECEIPT branches correctly on the query outcome', () => {
    expect(decideRecovery({ effectStarted: null, capability: 'QUERYABLE_RECEIPT', queriedReceiptOutcome: 'CONFIRMED' }).action).toBe('PROCEED_TO_NATIVE_RESULT');
    expect(decideRecovery({ effectStarted: null, capability: 'QUERYABLE_RECEIPT', queriedReceiptOutcome: 'ABSENT' }).action).toBe('RETRY_SAME_EFFECT');
    expect(decideRecovery({ effectStarted: null, capability: 'QUERYABLE_RECEIPT', queriedReceiptOutcome: 'STILL_UNKNOWN' }).action).toBe('UNKNOWN_EFFECT_OUTCOME');
  });
});

describe('terminalReasonFor', () => {
  it('is null for actions that leave the attempt open (more work still to do on it)', () => {
    expect(terminalReasonFor({ action: 'QUERY_EXTERNAL_RECEIPT', reason: 'x' }, null)).toBeNull();
    expect(terminalReasonFor({ action: 'PROCEED_TO_NATIVE_RESULT', reason: 'x' }, null)).toBeNull();
  });

  it('is FAILED_BEFORE_EFFECT for a retry backed by proof the effect never started', () => {
    expect(terminalReasonFor({ action: 'RETRY_SAME_EFFECT', reason: 'x' }, false)).toBe('FAILED_BEFORE_EFFECT');
  });

  it('is UNKNOWN_EFFECT_OUTCOME for a retry that is merely capability-safe, not proven', () => {
    expect(terminalReasonFor({ action: 'RETRY_SAME_EFFECT', reason: 'x' }, null)).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(terminalReasonFor({ action: 'RETRY_SAME_EFFECT', reason: 'x' }, true)).toBe('UNKNOWN_EFFECT_OUTCOME');
  });

  it('is UNKNOWN_EFFECT_OUTCOME for compensation and for an outright unknown decision', () => {
    expect(terminalReasonFor({ action: 'RUN_COMPENSATION', reason: 'x' }, null)).toBe('UNKNOWN_EFFECT_OUTCOME');
    expect(terminalReasonFor({ action: 'UNKNOWN_EFFECT_OUTCOME', reason: 'x' }, null)).toBe('UNKNOWN_EFFECT_OUTCOME');
  });
});
