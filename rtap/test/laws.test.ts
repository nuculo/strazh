import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/laws/index.js';

describe('law registry', () => {
  it('registers every law named in ARCHITECTURE.md §8, FROZEN_INTEGRATION.md §10, the two feature-view laws from ADAPTIVE_REDTEAM_RUNTIME.md §4.4/§14, the two Phase 3 shadow laws, the two Phase 6 domain-adapter laws, the four Phase 7 production-profile laws, the twelve Phase 4.5 execution-safety laws from EXECUTION_SAFETY_RECOVERY.md §14, the seven regression laws added for audit-found bugs (target-scoped binding, schema migrations, single-transaction fenced commit, outbox materialization matches full replay, adapter evidence is really stored, dispatch admission composes authorization and concurrency, recommendation provenance reflects its world), the settlement/reservation-pairing, back-pressure, coverage-denominator, and settled-attempt-eligibility laws from ARCH_CLAUDE_TRANSFER.md §2.1/§2.2/§2.4/§2.5, the four Phase 5 campaign-signal laws from FROZEN_INTEGRATION.md §5.4 (saturation, target drift, risk trend, grader disagreement), грань №14 (Грани Arch_claude)\'s corrupted-cache-falls-back-to-replay law, §15 criterion 13\'s runbook-covers-unknown-effect-outcome law, §15 criterion 14\'s rollback-disables-authorization-not-fencing law, грань №12\'s ask-is-durable-and-resolves-exactly-once law, грань №16\'s five model-signing-authority laws (sign-then-verify roundtrip with tamper detection, verify-only authority cannot sign, unsupported signature schemes are rejected loudly, weights-ref digest matches artifact sha256, and MODEL_ADMITTED requires a verified SignatureGate), and грань №17\'s three commitFencedObservations() laws (N pairs share one attempt, zero pairs still completes, fencing rejects all-or-nothing), ADAPTIVE_REDTEAM_RUNTIME.md §16\'s (a different §16 from грань №16) inference-determinism law backing promotion/phase16-admission.ts\'s Shadow criterion 6, and грань №18\'s seven key-rotation-and-revocation laws (keystore resolves by embedded keyId, unknown keyId fails closed, rotation preserves old-key verifiability, revoked key fails verification, AB_GATES_PASSED is blocked by a revoked key, OFFLINE_AND_SHADOW_GATES_PASSED stays ungated by signature, and sweepRevokedKeyDemotions() uses only legal per-state TRANSITIONS edges), грань №19\'s five admission-before-lease laws (peekLeasable() agrees with lease(), ConcurrencyScheduler.probe() agrees with reserve(), the concurrency precheck actually skips the lease_generation bump a naive lease-first loop would pay, authorize() is never called during the precheck itself, and AUTHORIZATION/ASK refusals still bump lease_generation as an explicit, accepted residual gap), and грань №20\'s six assessment_runs laws (start() is idempotent by campaign and rejects a mismatched one, intelligence_status reflects only the latest recordIntelligenceStatus() call, everDegradedAt is a separate sticky audit flag the live status field itself is not, coverage acceptance claims exactly once, the report is provably not gated on acceptance, and a real rankCandidates() fallback round-trips into a durable DEGRADED row)', () => {
    const registry = buildRegistry();
    const ids = registry.all().map((l) => l.id);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a.localeCompare(b)));
    expect(ids.length).toBe(94);
  });

  it('every implemented law holds at seed 1', async () => {
    const registry = buildRegistry();
    const report = await registry.runAll(1);
    const failing = report.results.filter((r) => r.status === 'implemented' && !r.held);
    expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
  });

  it('is honest about how many laws are still pending', async () => {
    const registry = buildRegistry();
    const report = await registry.runAll(1);
    expect(report.implemented + report.pending).toBe(report.total);
    expect(report.implemented).toBeGreaterThan(0);
    expect(report.pending).toBeGreaterThan(0);
    for (const r of report.results) {
      if (r.status === 'pending') {
        expect(r.pendingReason, `${r.id} has no pendingReason`).toBeTruthy();
      }
    }
  });

  it('a law run is replayable: the same seed reproduces the same verdict', async () => {
    const registry = buildRegistry();
    const a = await registry.run('redteam.planner/stale-recommendation-is-not-executed', 42);
    const b = await registry.run('redteam.planner/stale-recommendation-is-not-executed', 42);
    expect(a.held).toBe(b.held);
    expect(a.failures).toEqual(b.failures);
  });

  it('a mismatched RecommendationBinding is caught by the law even under adversarial seeds', async () => {
    const registry = buildRegistry();
    for (const seed of [1, 2, 3, 99, 12345]) {
      const report = await registry.run('redteam.planner/stale-recommendation-is-not-executed', seed);
      expect(report.held, JSON.stringify(report.failures)).toBe(true);
    }
  });
});
