import { describe, expect, it } from 'vitest';
import { isLegalRelation, LEGAL_RELATIONS } from '../../src/world/graph-schema.js';

describe('isLegalRelation', () => {
  it('accepts PROBE_TESTS_TARGET(ProbeClass, Target)', () => {
    expect(isLegalRelation({ type: 'PROBE_TESTS_TARGET', sourceType: 'ProbeClass', targetType: 'Target' })).toBe(true);
  });

  it('rejects a reversed direction', () => {
    expect(isLegalRelation({ type: 'PROBE_TESTS_TARGET', sourceType: 'Target', targetType: 'ProbeClass' })).toBe(false);
  });

  it('rejects a type-mismatched relation entirely', () => {
    expect(isLegalRelation({ type: 'TARGET_EXPOSES_FINDING', sourceType: 'ProbeClass', targetType: 'Target' })).toBe(false);
  });

  it('every relation type declared in LEGAL_RELATIONS is checkable', () => {
    for (const [type, [sourceType, targetType]] of Object.entries(LEGAL_RELATIONS)) {
      expect(isLegalRelation({ type: type as never, sourceType, targetType })).toBe(true);
    }
  });
});
