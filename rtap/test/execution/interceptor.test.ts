import { describe, expect, it } from 'vitest';
import { compilePlan, evaluateStageOutcomes, type InterceptorDescriptor } from '../../src/execution/interceptor.js';

function descriptor(overrides: Partial<InterceptorDescriptor> = {}): InterceptorDescriptor {
  return {
    interceptorId: 'interceptor-1',
    version: '1.0.0',
    stage: 'PRE_DISPATCH',
    criticality: 'ADVISORY',
    inputSchema: 'schema:in',
    outputSchema: 'schema:out',
    timeoutMs: 1000,
    sideEffectPolicy: 'NONE',
    ...overrides,
  };
}

describe('compilePlan', () => {
  it('orders descriptors by stage in the §10 canonical order, then by interceptorId', () => {
    const plan = compilePlan(1, 'policy-v1', [
      descriptor({ interceptorId: 'z', stage: 'PRE_REPORT' }),
      descriptor({ interceptorId: 'a', stage: 'PRE_DISPATCH' }),
      descriptor({ interceptorId: 'b', stage: 'PRE_DISPATCH' }),
      descriptor({ interceptorId: 'm', stage: 'POST_OBSERVATION_COMMIT' }),
    ]);
    expect(plan.orderedDescriptors.map((d) => d.interceptorId)).toEqual(['a', 'b', 'm', 'z']);
  });

  it('rejects a POST_OBSERVATION_COMMIT descriptor that declares CANONICAL_MUTATION', () => {
    const plan = compilePlan(1, 'policy-v1', [descriptor({ stage: 'POST_OBSERVATION_COMMIT', sideEffectPolicy: 'CANONICAL_MUTATION' })]);
    expect(plan.orderedDescriptors).toHaveLength(0);
    expect(plan.rejectedDescriptors).toHaveLength(1);
    expect(plan.rejectedDescriptors[0]!.reason).toContain('cannot mutate canonical state');
  });

  it('allows CANONICAL_MUTATION at any stage other than POST_OBSERVATION_COMMIT', () => {
    const plan = compilePlan(1, 'policy-v1', [descriptor({ stage: 'PRE_NORMALIZATION', sideEffectPolicy: 'CANONICAL_MUTATION' })]);
    expect(plan.orderedDescriptors).toHaveLength(1);
    expect(plan.rejectedDescriptors).toHaveLength(0);
  });

  it('produces the same digest for the same descriptor set regardless of input order', () => {
    const a = descriptor({ interceptorId: 'a' });
    const b = descriptor({ interceptorId: 'b', stage: 'PRE_REPORT' });
    const plan1 = compilePlan(1, 'policy-v1', [a, b]);
    const plan2 = compilePlan(1, 'policy-v1', [b, a]);
    expect(plan1.planDigest).toBe(plan2.planDigest);
  });

  it('produces a different digest for a different descriptor set', () => {
    const plan1 = compilePlan(1, 'policy-v1', [descriptor({ interceptorId: 'a' })]);
    const plan2 = compilePlan(1, 'policy-v1', [descriptor({ interceptorId: 'a', version: '2.0.0' })]);
    expect(plan1.planDigest).not.toBe(plan2.planDigest);
  });
});

describe('evaluateStageOutcomes', () => {
  it('admits the stage when every interceptor reports ok', () => {
    const plan = compilePlan(1, 'policy-v1', [descriptor({ interceptorId: 'a', criticality: 'SECURITY_CRITICAL' })]);
    const result = evaluateStageOutcomes(plan, 'PRE_DISPATCH', [{ interceptorId: 'a', ok: true }]);
    expect(result.admitted).toBe(true);
  });

  it('a failed SECURITY_CRITICAL interceptor blocks admission (fail-closed)', () => {
    const plan = compilePlan(1, 'policy-v1', [descriptor({ interceptorId: 'a', criticality: 'SECURITY_CRITICAL' })]);
    const result = evaluateStageOutcomes(plan, 'PRE_DISPATCH', [{ interceptorId: 'a', ok: false, diagnostic: 'blocked' }]);
    expect(result.admitted).toBe(false);
    expect(result.failedCritical).toEqual(['a']);
  });

  it('a failed ADVISORY interceptor does not block admission, but is reported with its diagnostic (fail-open with typed diagnostic)', () => {
    const plan = compilePlan(1, 'policy-v1', [descriptor({ interceptorId: 'a', criticality: 'ADVISORY' })]);
    const result = evaluateStageOutcomes(plan, 'PRE_DISPATCH', [{ interceptorId: 'a', ok: false, diagnostic: 'non-critical hiccup' }]);
    expect(result.admitted).toBe(true);
    expect(result.failedAdvisory).toEqual([{ interceptorId: 'a', diagnostic: 'non-critical hiccup' }]);
  });

  it('a SECURITY_CRITICAL interceptor with no reported outcome at all is treated as failed, never assumed to pass', () => {
    const plan = compilePlan(1, 'policy-v1', [descriptor({ interceptorId: 'a', criticality: 'SECURITY_CRITICAL' })]);
    const result = evaluateStageOutcomes(plan, 'PRE_DISPATCH', []);
    expect(result.admitted).toBe(false);
  });

  it('ignores interceptors from a different stage', () => {
    const plan = compilePlan(1, 'policy-v1', [
      descriptor({ interceptorId: 'a', stage: 'PRE_DISPATCH', criticality: 'SECURITY_CRITICAL' }),
      descriptor({ interceptorId: 'b', stage: 'PRE_REPORT', criticality: 'SECURITY_CRITICAL' }),
    ]);
    const result = evaluateStageOutcomes(plan, 'PRE_DISPATCH', [{ interceptorId: 'a', ok: true }]);
    expect(result.admitted).toBe(true);
  });
});
