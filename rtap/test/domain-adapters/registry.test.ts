import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { DomainAdapterRegistry } from '../../src/domain-adapters/registry.js';
import { evaluateAdapterAdmission, cellKey, type CrossDomainMatrix } from '../../src/domain-adapters/matrix.js';
import type { DomainAdapterMetadata } from '../../src/domain-adapters/metadata.js';

const goodMatrix: CrossDomainMatrix = {
  adapterScores: new Map([[cellKey('fin-adp', 'financial'), 0.85]]),
  baselineScores: new Map([['financial', 0.7]]),
};
const goodAdmission = evaluateAdapterAdmission(goodMatrix, 'fin-adp', 'financial');
const overlayMetadata: DomainAdapterMetadata = { adapterRef: 'fin-adp', domain: 'financial', parentCoreRef: 'core-1', reassignEvery: 0 };

describe('DomainAdapterRegistry', () => {
  it('has no active adapter for an unknown domain', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    expect(registry.getActive('financial')).toBeNull();
  });

  it('swaps in an admitted, overlay-only adapter at a run boundary', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    const result = registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    expect(result.allowed).toBe(true);
    expect(registry.getActive('financial')).toBe('fin-adp');
  });

  it('rejects a mid-run swap and does not change the active adapter', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    const result = registry.swap({ domain: 'financial', newAdapterRef: 'other-adp', timing: 'MID_RUN' }, goodAdmission, overlayMetadata);
    expect(result.allowed).toBe(false);
    expect(registry.getActive('financial')).toBe('fin-adp');
  });

  it('rejects a non-admitted adapter and does not change the active adapter', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    const badAdmission = { ...goodAdmission, admitted: false, reasonCodes: ['own-domain-gain-insufficient'] };
    const result = registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, badAdmission, overlayMetadata);
    expect(result.allowed).toBe(false);
    expect(registry.getActive('financial')).toBeNull();
  });

  it('rejects an adapter with reassignEvery > 0 even if the cross-domain matrix admits it', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    const nonOverlayMetadata: DomainAdapterMetadata = { ...overlayMetadata, reassignEvery: 3 };
    const result = registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, nonOverlayMetadata);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('reassignEvery');
  });

  it('allows swapping back to the general core (null)', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    const result = registry.swap({ domain: 'financial', newAdapterRef: null, timing: 'RUN_BOUNDARY' }, null, null);
    expect(result.allowed).toBe(true);
    expect(registry.getActive('financial')).toBeNull();
  });

  it('rollback reverts to the previous adapter', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    const secondAdmission = evaluateAdapterAdmission(
      { adapterScores: new Map([[cellKey('fin-adp-v2', 'financial'), 0.9]]), baselineScores: new Map([['financial', 0.7]]) },
      'fin-adp-v2',
      'financial',
    );
    registry.swap(
      { domain: 'financial', newAdapterRef: 'fin-adp-v2', timing: 'RUN_BOUNDARY' },
      secondAdmission,
      { ...overlayMetadata, adapterRef: 'fin-adp-v2' },
    );
    expect(registry.getActive('financial')).toBe('fin-adp-v2');

    const rollback = registry.rollback('financial');
    expect(rollback.allowed).toBe(true);
    expect(registry.getActive('financial')).toBe('fin-adp');
  });

  it('rollback with exactly one prior swap reverts to the implicit "no adapter" start state', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    const result = registry.rollback('financial');
    expect(result.allowed).toBe(true);
    expect(registry.getActive('financial')).toBeNull();
  });

  it('rollback fails gracefully on a domain with zero swaps', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    const result = registry.rollback('never-touched-domain');
    expect(result.allowed).toBe(false);
  });

  it('history records every attempt, allowed or not, in order', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    registry.swap({ domain: 'financial', newAdapterRef: 'bad', timing: 'MID_RUN' }, goodAdmission, overlayMetadata);
    const history = registry.history('financial');
    expect(history.map((h) => h.allowed)).toEqual([true, false]);
  });

  it('keeps separate state per domain', () => {
    const registry = new DomainAdapterRegistry(openInMemoryDatabase());
    registry.swap({ domain: 'financial', newAdapterRef: 'fin-adp', timing: 'RUN_BOUNDARY' }, goodAdmission, overlayMetadata);
    expect(registry.getActive('medical')).toBeNull();
  });
});
