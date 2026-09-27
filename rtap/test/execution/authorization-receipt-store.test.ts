import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { AuthorizationReceiptStore } from '../../src/execution/authorization-receipt-store.js';
import type { AuthorizationReceipt } from '../../src/execution/authorization.js';

function receipt(overrides: Partial<AuthorizationReceipt> = {}): AuthorizationReceipt {
  return {
    authorizationId: 'authz-1',
    campaignId: 'campaign-1',
    assessmentRunId: 'run-1',
    runStepId: 'step-1',
    operationFamily: 'llm-attack',
    targetSnapshotRef: 'target-snapshot-1',
    adapterIdentity: { engineAdapterId: 'promptfoo', engineAdapterVersion: '0.1.0' },
    adapterCapabilityDigest: 'digest-1',
    policyRevision: 'policy-v1',
    sandboxProfileRef: 'sandbox-1',
    egressPolicyRef: 'egress-1',
    approvedAt: '2026-08-30T00:00:00.000Z',
    expiresAt: '2026-08-30T00:01:00.000Z',
    ...overrides,
  };
}

describe('AuthorizationReceiptStore', () => {
  it('records and reads back a receipt by authorizationId', () => {
    const store = new AuthorizationReceiptStore(openInMemoryDatabase());
    store.record(receipt());
    expect(store.get('authz-1')).toEqual(receipt());
  });

  it('returns null for an unknown authorizationId', () => {
    const store = new AuthorizationReceiptStore(openInMemoryDatabase());
    expect(store.get('no-such-receipt')).toBeNull();
  });

  it('lists every receipt for a RunStep, in issuance order', () => {
    const store = new AuthorizationReceiptStore(openInMemoryDatabase());
    store.record(receipt({ authorizationId: 'authz-1', approvedAt: '2026-08-30T00:00:00.000Z' }));
    store.record(receipt({ authorizationId: 'authz-2', approvedAt: '2026-08-30T00:00:05.000Z' }));
    const list = store.listByRunStep('step-1');
    expect(list.map((r) => r.authorizationId)).toEqual(['authz-1', 'authz-2']);
  });

  it('preserves null sandboxProfileRef/egressPolicyRef through the round trip', () => {
    const store = new AuthorizationReceiptStore(openInMemoryDatabase());
    store.record(receipt({ sandboxProfileRef: null, egressPolicyRef: null }));
    const stored = store.get('authz-1');
    expect(stored?.sandboxProfileRef).toBeNull();
    expect(stored?.egressPolicyRef).toBeNull();
  });
});
