import { describe, expect, it } from 'vitest';
import { capabilityKey, declareCapabilities, resolveCapability } from '../../src/execution/capability-declarations.js';

describe('resolveCapability', () => {
  it('returns the declared capability for a known engineAdapterId/operationFamily pair', () => {
    const declarations = declareCapabilities([{ engineAdapterId: 'promptfoo', operationFamily: 'llm-attack', capability: 'IDEMPOTENT_BY_KEY' }]);
    expect(resolveCapability(declarations, { engineAdapterId: 'promptfoo', operationFamily: 'llm-attack' })).toBe('IDEMPOTENT_BY_KEY');
  });

  it('defaults undeclared operations to AT_MOST_ONCE_UNPROVEN — §6\'s stated default', () => {
    const declarations = declareCapabilities([]);
    expect(resolveCapability(declarations, { engineAdapterId: 'duo-static', operationFamily: 'scan' })).toBe('AT_MOST_ONCE_UNPROVEN');
  });

  it('does not leak a declaration across a different engineAdapterId with the same operationFamily', () => {
    const declarations = declareCapabilities([{ engineAdapterId: 'promptfoo', operationFamily: 'scan', capability: 'COMPENSATABLE' }]);
    expect(resolveCapability(declarations, { engineAdapterId: 'duo-static', operationFamily: 'scan' })).toBe('AT_MOST_ONCE_UNPROVEN');
  });

  it('capabilityKey does not collide when a plain delimiter-join would', () => {
    // A naive `${a}:${b}` join would make these two equal ("x:y:z" both ways).
    expect(capabilityKey({ engineAdapterId: 'x:y', operationFamily: 'z' })).not.toBe(capabilityKey({ engineAdapterId: 'x', operationFamily: 'y:z' }));
  });
});
