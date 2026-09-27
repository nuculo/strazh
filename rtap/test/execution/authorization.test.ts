import { describe, expect, it } from 'vitest';
import { evaluateAuthorization, isReceiptValid, receiptCoversAdapter, type AuthorizeEffectRequest } from '../../src/execution/authorization.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import type { Principal } from '../../src/authz/types.js';

function validRequest(overrides: Partial<AuthorizeEffectRequest> = {}): AuthorizeEffectRequest {
  const principal: Principal = { subjectId: 's1', tenantId: 'tenant-a', roles: ['OPERATOR'] };
  return {
    principal,
    resourceTenantId: 'tenant-a',
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    runStepId: 'step-1',
    operationFamily: 'llm-attack',
    targetSnapshotRef: 'target-snapshot-1',
    adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' },
    declaredCapabilityDigest: 'digest-1',
    expectedCapabilityDigest: 'digest-1',
    policyRevision: 'policy-v1',
    sandboxProfileRef: 'sandbox-1',
    egressPolicyRef: 'egress-1',
    receiptDurationMs: 60_000,
    ...overrides,
  };
}

describe('evaluateAuthorization', () => {
  const provider = new RoleBasedAuthorizationProvider();

  it('issues a receipt when every stage passes', () => {
    const result = evaluateAuthorization(validRequest(), provider);
    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect(result.receipt.runStepId).toBe('step-1');
      expect(result.receipt.adapterIdentity).toEqual({ engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' });
    }
  });

  it('rejects MALFORMED_REQUEST for an empty required field', () => {
    const result = evaluateAuthorization(validRequest({ targetSnapshotRef: '' }), provider);
    expect(result).toMatchObject({ authorized: false, reason: 'MALFORMED_REQUEST' });
  });

  it('rejects CAPABILITY_DIGEST_MISMATCH before ever consulting policy', () => {
    const result = evaluateAuthorization(validRequest({ declaredCapabilityDigest: 'digest-other', principal: { subjectId: 's1', tenantId: 'tenant-a', roles: [] } }), provider);
    expect(result).toMatchObject({ authorized: false, reason: 'CAPABILITY_DIGEST_MISMATCH' });
  });

  it('rejects POLICY_DENIED for a principal without run-step:dispatch', () => {
    const result = evaluateAuthorization(validRequest({ principal: { subjectId: 's1', tenantId: 'tenant-a', roles: ['VIEWER'] } }), provider);
    expect(result).toMatchObject({ authorized: false, reason: 'POLICY_DENIED' });
  });

  it('rejects POLICY_DENIED for a cross-tenant request even for an OPERATOR', () => {
    const result = evaluateAuthorization(validRequest({ resourceTenantId: 'tenant-b' }), provider);
    expect(result).toMatchObject({ authorized: false, reason: 'POLICY_DENIED' });
  });

  it('rejects SANDBOX_OR_EGRESS_POLICY_MISSING when either ref is null', () => {
    expect(evaluateAuthorization(validRequest({ sandboxProfileRef: null }), provider)).toMatchObject({ authorized: false, reason: 'SANDBOX_OR_EGRESS_POLICY_MISSING' });
    expect(evaluateAuthorization(validRequest({ egressPolicyRef: null }), provider)).toMatchObject({ authorized: false, reason: 'SANDBOX_OR_EGRESS_POLICY_MISSING' });
  });

  it('computes expiresAt from receiptDurationMs relative to now', () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const result = evaluateAuthorization(validRequest({ receiptDurationMs: 30_000 }), provider, now);
    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect(result.receipt.approvedAt).toBe(now.toISOString());
      expect(result.receipt.expiresAt).toBe(new Date(now.getTime() + 30_000).toISOString());
    }
  });
});

describe('isReceiptValid', () => {
  it('is true before expiry and false at/after it', () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const provider = new RoleBasedAuthorizationProvider();
    const result = evaluateAuthorization(validRequest({ receiptDurationMs: 1000 }), provider, now);
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(isReceiptValid(result.receipt, new Date(now.getTime() + 500))).toBe(true);
    expect(isReceiptValid(result.receipt, new Date(now.getTime() + 1000))).toBe(false);
    expect(isReceiptValid(result.receipt, new Date(now.getTime() + 5000))).toBe(false);
  });
});

describe('receiptCoversAdapter', () => {
  it('matches the exact adapter identity and digest the receipt was issued for', () => {
    const provider = new RoleBasedAuthorizationProvider();
    const result = evaluateAuthorization(validRequest(), provider);
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(receiptCoversAdapter(result.receipt, { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' }, 'digest-1')).toBe(true);
  });

  it('rejects a version bump, an adapter change, or a digest change — any of the three requires new authorization', () => {
    const provider = new RoleBasedAuthorizationProvider();
    const result = evaluateAuthorization(validRequest(), provider);
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(receiptCoversAdapter(result.receipt, { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.2.0' }, 'digest-1')).toBe(false);
    expect(receiptCoversAdapter(result.receipt, { engineAdapterId: 'duo-static', engineAdapterVersion: '0.1.0' }, 'digest-1')).toBe(false);
    expect(receiptCoversAdapter(result.receipt, { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' }, 'digest-2')).toBe(false);
  });
});
