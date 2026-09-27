import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { CampaignEventStore } from '../../src/events/store.js';
import { replay } from '../../src/world/replay.js';
import { snapshotWorld, verifySnapshot } from '../../src/world/snapshot.js';
import { FilesystemArtifactStore } from '../../src/artifacts/filesystem-store.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { RoleBasedAuthorizationProvider } from '../../src/authz/role-based-provider.js';
import { AuditLog } from '../../src/audit/log.js';
import { AuditingAuthorizationProvider } from '../../src/audit/auditing-authorization-provider.js';
import type { Principal } from '../../src/authz/types.js';

/**
 * Phase 7 vertical slice: an OPERATOR in one tenant dispatches a run step, resolves
 * a target credential, and stores real evidence for an Observation committed to the
 * *same* Phase 4 CampaignEventStore/replay path every other phase uses — then the
 * resulting world is snapshotted and the snapshot verified. A same-tenant privilege
 * escalation attempt and a cross-tenant access attempt are both denied and both
 * land in the audit trail, which is the point of wiring RBAC through
 * AuditingAuthorizationProvider rather than leaving audit logging optional per call site.
 */
describe('Phase 7 vertical slice: production profile (artifacts, secrets, RBAC, audit, snapshot)', () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), 'rtap-slice-artifacts-'));
    process.env.RTAP_TEST_TARGET_KEY = 'target-credential-value';
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
    delete process.env.RTAP_TEST_TARGET_KEY;
  });

  it('authorizes, resolves a secret, stores evidence, commits+replays an event, and snapshots the world — with every authz decision audited', async () => {
    const db = openInMemoryDatabase();
    const events = new CampaignEventStore(db);
    const audit = new AuditLog(db);
    const authz = new AuditingAuthorizationProvider(new RoleBasedAuthorizationProvider(), audit);
    const secrets = new EnvSecretProvider();
    const artifacts = new FilesystemArtifactStore(artifactRoot);

    const operator: Principal = { subjectId: 'operator-1', tenantId: 'tenant-a', roles: ['OPERATOR'] };
    const campaignId = 'campaign-slice-1';

    const dispatchDecision = authz.authorize({ principal: operator, action: 'run-step:dispatch', resourceTenantId: 'tenant-a' });
    expect(dispatchDecision.allowed).toBe(true);

    const resolved = await secrets.resolve('env:RTAP_TEST_TARGET_KEY');
    expect(resolved.value).toBe('target-credential-value');

    const evidence = await artifacts.put({ assessmentRunId: 'run-1', kind: 'response', body: 'raw target response text' });
    expect(evidence.ref).toMatch(/^local:sha256:/);

    const appended = events.append({
      schemaVersion: '1.0.0',
      eventId: 'evt-slice-1',
      campaignId,
      assessmentRunId: 'run-1',
      occurredAt: '2026-08-30T00:00:00.000Z',
      eventType: 'VulnerabilityObserved',
      sourceObservationIds: [],
      featureSnapshotRef: null,
      taxonomySnapshotRef: null,
      payload: { targetId: 'target-1', probeId: 'probe-1:strategy-1', verdict: 'VULNERABLE', evidenceRef: evidence.ref },
    });
    expect(appended.deduped).toBe(false);

    const replayResult = replay(events.listByCampaign(campaignId), campaignId);
    expect(replayResult.stoppedAt).toBeNull();

    const snapshot = snapshotWorld(replayResult.world, { modelSnapshotRef: null, worldBinding: null });
    expect(verifySnapshot(snapshot, replayResult.world)).toEqual({ valid: true });

    // The OPERATOR cannot promote a model — same tenant, wrong role.
    const promoteDecision = authz.authorize({ principal: operator, action: 'model:promote', resourceTenantId: 'tenant-a' });
    expect(promoteDecision.allowed).toBe(false);

    // A principal from another tenant cannot touch tenant-a's resources at all, even to read.
    const outsider: Principal = { subjectId: 'outsider-1', tenantId: 'tenant-b', roles: ['ADMIN'] };
    const crossTenantDecision = authz.authorize({ principal: outsider, action: 'campaign:read', resourceTenantId: 'tenant-a' });
    expect(crossTenantDecision.allowed).toBe(false);

    // Every decision above — the two allowed dispatch-time checks plus the two denials — is audited.
    const tenantAEntries = audit.listByTenant('tenant-a');
    expect(tenantAEntries.map((e) => ({ action: e.action, allowed: e.allowed }))).toEqual([
      { action: 'run-step:dispatch', allowed: true },
      { action: 'model:promote', allowed: false },
    ]);
    const tenantBEntries = audit.listByTenant('tenant-b');
    expect(tenantBEntries).toHaveLength(1);
    expect(tenantBEntries[0]).toMatchObject({ action: 'campaign:read', allowed: false, resourceTenantId: 'tenant-a' });
  });
});
