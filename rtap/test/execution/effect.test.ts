import { describe, expect, it } from 'vitest';
import { attemptEffectTransition, legalEventsFrom, TERMINAL_EFFECT_STATES } from '../../src/execution/effect.js';

describe('attemptEffectTransition', () => {
  it('walks the full happy path from ADMITTED to EVENT_PUBLISHED', () => {
    const path: [Parameters<typeof attemptEffectTransition>[0], Parameters<typeof attemptEffectTransition>[1]][] = [
      ['ADMITTED', 'POLICY_AND_CAPABILITY_PASS'],
      ['AUTHORIZED', 'ADAPTER_DISPATCH'],
      ['EFFECT_STARTED', 'EXTERNAL_RECEIPT'],
      ['EFFECT_ACKNOWLEDGED', 'RESULT_PERSISTED'],
      ['NATIVE_RESULT_RECEIVED', 'SCHEMA_AND_PROVENANCE_PASS'],
      ['RESULT_NORMALIZED', 'ATOMIC_DOMAIN_TRANSACTION'],
      ['OBSERVATION_COMMITTED', 'OUTBOX_DELIVERY'],
    ];
    for (const [from, event] of path) {
      const result = attemptEffectTransition(from, event);
      expect(result.allowed, `${from} --${event}--> ?`).toBe(true);
    }
  });

  it('rejects EFFECT_STARTED going directly to OBSERVATION_COMMITTED via any event', () => {
    for (const event of legalEventsFrom('EFFECT_STARTED')) {
      const result = attemptEffectTransition('EFFECT_STARTED', event);
      expect(result.to).not.toBe('OBSERVATION_COMMITTED');
    }
  });

  it('rejects an event not legal from the given state, without coercing to a nearby state', () => {
    const result = attemptEffectTransition('ADMITTED', 'ADAPTER_DISPATCH');
    expect(result).toEqual({ allowed: false, from: 'ADMITTED', to: 'ADMITTED' });
  });

  it('every terminal state has no legal outgoing events', () => {
    for (const state of TERMINAL_EFFECT_STATES) {
      expect(legalEventsFrom(state)).toEqual([]);
    }
  });

  it('EFFECT_STARTED can reach UNKNOWN_EFFECT_OUTCOME directly (crash or lost ack)', () => {
    const result = attemptEffectTransition('EFFECT_STARTED', 'CRASH_OR_LOST_ACK');
    expect(result).toEqual({ allowed: true, from: 'EFFECT_STARTED', to: 'UNKNOWN_EFFECT_OUTCOME' });
  });
});
