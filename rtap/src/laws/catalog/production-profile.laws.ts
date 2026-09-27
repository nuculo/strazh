import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mulberry32, pick, randInt } from '../rng.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { FilesystemArtifactStore } from '../../artifacts/filesystem-store.js';
import { materializeEvidence, type EvidenceBody } from '../../artifacts/materialize.js';
import type { EvidenceKind } from '../../artifacts/store.js';
import { RoleBasedAuthorizationProvider } from '../../authz/role-based-provider.js';
import { AuditLog } from '../../audit/log.js';
import { AuditingAuthorizationProvider } from '../../audit/auditing-authorization-provider.js';
import { snapshotWorld, verifySnapshot } from '../../world/snapshot.js';
import { emptyWorld, type CampaignWorldState } from '../../world/state.js';
import type { Action, Principal, Role } from '../../authz/types.js';
import type { Law } from '../types.js';

// Phase 7 — production profile. No pre-existing law IDs for any of these: none of
// the four tracked docs enumerate individual laws for ArtifactStore/SecretProvider/
// AuthorizationProvider/audit/snapshot, only the ports and bullet points themselves
// (ARCHITECTURE.md §3.4, §9 Phase 7). IDs derived from those.

/**
 * Each trial gets its own temp dir, used, and removed before the trial returns —
 * tied to the trial's own lifetime rather than a module-level dir cleaned on
 * `process.on('exit')`, which vitest's worker pool does not reliably fire. There's
 * no live S3 bucket to point this law at instead; see filesystem-store.ts.
 */
async function withTempArtifactStore<T>(fn: (store: FilesystemArtifactStore) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'rtap-law-artifacts-'));
  try {
    return await fn(new FilesystemArtifactStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function randomBody(rng: () => number): string {
  const length = randInt(rng, 1, 200);
  let s = '';
  for (let i = 0; i < length; i += 1) s += String.fromCharCode(randInt(rng, 33, 126));
  return s;
}

const EVIDENCE_KINDS: EvidenceKind[] = ['payload', 'response', 'trace', 'snippet', 'native-report'];

const ALL_ROLES: Role[] = ['VIEWER', 'OPERATOR', 'ADMIN'];
const ALL_ACTIONS: Action[] = [
  'campaign:read',
  'observation:read',
  'finding:read',
  'run-step:dispatch',
  'model:promote',
  'domain-adapter:swap',
  'secret:resolve',
  'artifact:read',
  'artifact:write',
];

function randomRoles(rng: () => number): Role[] {
  const roles = ALL_ROLES.filter(() => rng() < 0.5);
  return roles.length > 0 ? roles : [pick(rng, ALL_ROLES)];
}

function randomWorld(rng: () => number): CampaignWorldState {
  const base = emptyWorld(`campaign-${randInt(rng, 1, 999)}`, randInt(rng, 0, 5));
  const entityCount = randInt(rng, 0, 4);
  const entities = new Map(base.entities);
  for (let i = 0; i < entityCount; i += 1) {
    const id = `entity-${i}`;
    entities.set(id, { id, type: 'Target', firstSeenSequence: i, lastUpdatedSequence: i });
  }
  return { ...base, epoch: randInt(rng, 0, 50), lastSequence: randInt(rng, -1, 50), entities };
}

export const productionProfileLaws: Law[] = [
  {
    id: 'redteam.artifact/store-is-content-addressed',
    statement:
      'FilesystemArtifactStore.put() is content-addressed: putting the same bytes twice always yields the same ref, and putting different bytes always yields a different ref — a ref can never point at content other than what produced it.',
    status: 'implemented',
    trials: 100,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const bodyA = randomBody(rng);
      let bodyB = randomBody(rng);
      while (bodyB === bodyA) bodyB = randomBody(rng);

      return withTempArtifactStore(async (store) => {
        const put1 = await store.put({ assessmentRunId: 'run-1', kind: 'payload', body: bodyA });
        const put2 = await store.put({ assessmentRunId: 'run-1', kind: 'payload', body: bodyA });
        const put3 = await store.put({ assessmentRunId: 'run-2', kind: 'payload', body: bodyB });

        if (put1.ref !== put2.ref) {
          return { held: false, detail: 'Identical content produced two different refs', counterexample: { bodyA, put1, put2 } };
        }
        if (put1.ref === put3.ref) {
          return { held: false, detail: 'Distinct content produced the same ref', counterexample: { bodyA, bodyB, put1, put3 } };
        }
        const fetched = await store.get(put1);
        if (fetched.toString('utf-8') !== bodyA) {
          return { held: false, detail: 'Fetched content did not match what was put', counterexample: { bodyA, fetched: fetched.toString('utf-8') } };
        }
        return { held: true };
      });
    },
  },
  {
    id: 'redteam.authz/cross-tenant-access-is-always-denied',
    statement:
      'RoleBasedAuthorizationProvider.authorize() denies any request where principal.tenantId differs from resourceTenantId, regardless of role — including ADMIN. Tenant isolation is a boundary a role cannot be granted out of.',
    status: 'implemented',
    trials: 300,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const provider = new RoleBasedAuthorizationProvider();
      const principal: Principal = { subjectId: 'subject-1', tenantId: `tenant-${randInt(rng, 1, 50)}`, roles: randomRoles(rng) };
      let resourceTenantId = `tenant-${randInt(rng, 1, 50)}`;
      while (resourceTenantId === principal.tenantId) resourceTenantId = `tenant-${randInt(rng, 1, 50)}`;
      const action = pick(rng, ALL_ACTIONS);

      const decision = provider.authorize({ principal, action, resourceTenantId });
      if (decision.allowed) {
        return { held: false, detail: 'A cross-tenant request was allowed', counterexample: { principal, action, resourceTenantId, decision } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.audit/every-decision-is-recorded',
    statement:
      'AuditingAuthorizationProvider records every authorize() decision — allowed and denied alike — to AuditLog before returning it. After N calls for one tenant, AuditLog.listByTenant() for that tenant has exactly N entries, in call order, each matching the decision that was returned.',
    status: 'implemented',
    trials: 100,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const db = openInMemoryDatabase();
      const audit = new AuditLog(db);
      const auditing = new AuditingAuthorizationProvider(new RoleBasedAuthorizationProvider(), audit);
      const tenantId = `tenant-${seed}`;
      const callCount = randInt(rng, 1, 15);

      const expected: { action: Action; allowed: boolean }[] = [];
      for (let i = 0; i < callCount; i += 1) {
        const principal: Principal = { subjectId: `subject-${i}`, tenantId, roles: randomRoles(rng) };
        const crossTenant = rng() < 0.3;
        const resourceTenantId = crossTenant ? `${tenantId}-other` : tenantId;
        const action = pick(rng, ALL_ACTIONS);
        const decision = auditing.authorize({ principal, action, resourceTenantId });
        expected.push({ action, allowed: decision.allowed });
      }

      const recorded = audit.listByTenant(tenantId);
      if (recorded.length !== callCount) {
        return { held: false, detail: `Expected ${callCount} audit entries, found ${recorded.length}`, counterexample: { expected, recorded } };
      }
      for (let i = 0; i < callCount; i += 1) {
        if (recorded[i]!.action !== expected[i]!.action || recorded[i]!.allowed !== expected[i]!.allowed) {
          return { held: false, detail: `Audit entry ${i} does not match the decision that was returned`, counterexample: { expected: expected[i], recorded: recorded[i] } };
        }
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.world/snapshot-digest-detects-tampering',
    statement:
      'verifySnapshot() holds for a WorldSnapshot exactly as produced by snapshotWorld(); mutating any single recorded field (epoch, lastSequence, fingerprint, generation, or the digest itself) always makes it fail — a snapshot can never be silently altered and still verify.',
    status: 'implemented',
    trials: 150,
    check: ({ seed }) => {
      const rng = mulberry32(seed);
      const world = randomWorld(rng);
      const snapshot = snapshotWorld(world, { modelSnapshotRef: null, worldBinding: null });

      const genuine = verifySnapshot(snapshot, world);
      if (!genuine.valid) {
        return { held: false, detail: 'A freshly taken snapshot did not verify against its own world', counterexample: { snapshot, world, genuine } };
      }

      const field = pick(rng, ['epoch', 'lastSequence', 'generation', 'fingerprint', 'digest'] as const);
      const tampered =
        field === 'fingerprint' || field === 'digest'
          ? { ...snapshot, [field]: `${snapshot[field]}ff` }
          : { ...snapshot, [field]: snapshot[field] + 1 };
      const result = verifySnapshot(tampered);
      if (result.valid) {
        return { held: false, detail: `Tampering with '${field}' was not detected`, counterexample: { snapshot, tampered } };
      }
      return { held: true };
    },
  },
  {
    id: 'redteam.artifact/adapter-evidence-is-really-stored',
    statement:
      "Audit finding #5: materializeEvidence() — the function every adapter's evidence.ts wraps to turn a native result's real bytes into an Observation's evidenceRefs — never returns a ref that does not resolve, via ArtifactStore.get(), to the exact bytes it was given, for any number of bodies of any declared EvidenceKind, in the order supplied. Two calls given the same (kind, body) pairs always yield the same ref, whether in the same batch or a separate one — the multi-body, mixed-kind path a single adapter's evidence.ts actually exercises, not just the single-put case redteam.artifact/store-is-content-addressed already covers.",
    status: 'implemented',
    trials: 150,
    check: async ({ seed }) => {
      const rng = mulberry32(seed);
      const count = randInt(rng, 1, 6);
      const bodies: EvidenceBody[] = Array.from({ length: count }, () => ({ kind: pick(rng, EVIDENCE_KINDS), body: randomBody(rng) }));

      return withTempArtifactStore(async (store) => {
        const refs = await materializeEvidence(store, 'run-1', bodies);
        if (refs.length !== bodies.length) {
          return { held: false, detail: `Expected ${bodies.length} refs, got ${refs.length}`, counterexample: { bodies, refs } };
        }
        for (let i = 0; i < bodies.length; i += 1) {
          if (refs[i]!.kind !== bodies[i]!.kind) {
            return { held: false, detail: `Ref ${i} kind does not match the body it was given`, counterexample: { body: bodies[i], ref: refs[i] } };
          }
          const fetched = await store.get(refs[i]!);
          if (fetched.toString('utf-8') !== bodies[i]!.body) {
            return { held: false, detail: `Ref ${i} did not resolve to the exact bytes it was given`, counterexample: { body: bodies[i], ref: refs[i], fetched: fetched.toString('utf-8') } };
          }
        }

        // A second, independent call with the same bodies must land on the same refs.
        const refsAgain = await materializeEvidence(store, 'run-2', bodies);
        for (let i = 0; i < bodies.length; i += 1) {
          if (refsAgain[i]!.ref !== refs[i]!.ref) {
            return { held: false, detail: `Ref ${i} was not stable across a second materializeEvidence() call for identical content`, counterexample: { body: bodies[i], first: refs[i], second: refsAgain[i] } };
          }
        }
        return { held: true };
      });
    },
  },
];
