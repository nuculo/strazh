import { parseSignatureKeyId } from '../signing/authority.js';
import type { SigningKeyStore } from '../signing/key-store.js';
import type { ModelPromotionRegistry, PromotionRecord, TransitionLogEntry } from './registry.js';
import type { PromotionState } from './types.js';

export interface AffectedModel {
  readonly modelRef: string;
  readonly state: PromotionState;
  readonly keyId: string;
  readonly revokedAt: string;
  readonly revokedReason: string | null;
}

/**
 * грань №18: every currently-promoted (`state !== 'OFF'`) model whose stored
 * artifact was signed under a now-revoked key. `state !== 'OFF'` filtering is
 * both semantically right (`authorityFor('OFF')` already grants zero authority —
 * nothing to protect against there) and required for legality: `TRANSITIONS` has
 * no `INTEGRITY_OR_POLICY_FAILURE`/`ARTIFACT_OR_SCHEMA_INVALID` edge FROM `OFF`,
 * so attempting either on an OFF model would just log a harmless refusal.
 *
 * A record whose signature doesn't parse (`parseSignatureKeyId()` returns null —
 * the literal `'UNSIGNED'` sentinel, or any malformed string) is skipped, not
 * flagged: this function answers "which models are exposed by a *revoked key*,"
 * not "which models have a bad signature" — an unsigned artifact could only have
 * reached a live state by bypassing `attemptModelTransition()` entirely (it
 * can't, today), which is a different problem than this one.
 */
export function findModelsOnRevokedKeys(records: readonly PromotionRecord[], keyStore: SigningKeyStore): AffectedModel[] {
  const affected: AffectedModel[] = [];
  for (const record of records) {
    if (record.state === 'OFF') continue;
    const parsed = parseSignatureKeyId(record.artifact.signature);
    if (!parsed) continue;
    const key = keyStore.get(parsed.keyId);
    if (!key?.revokedAt) continue;
    affected.push({ modelRef: record.modelRef, state: record.state, keyId: parsed.keyId, revokedAt: key.revokedAt, revokedReason: key.revokedReason });
  }
  return affected;
}

/**
 * Demotes every model `findModelsOnRevokedKeys()` finds, to `OFF`, via whichever
 * `TRANSITIONS` edges are actually legal from its current state today —
 * `TRANSITIONS` itself is deliberately NOT edited to add a uniform
 * `INTEGRITY_OR_POLICY_FAILURE` edge from `SHADOW`/`EXPERIMENTAL` the way an
 * earlier draft of this facet considered: `ADAPTIVE_REDTEAM_RUNTIME.md` §9.2 and
 * `FROZEN_META_HARNESS.md` §10 both document `INTEGRITY_OR_POLICY_FAILURE -> OFF`
 * from `CALIBRATED` only — `promotion/types.ts`'s `TRANSITIONS` comment says it's
 * "taken verbatim from the documented state diagram," and editing it to add an
 * edge neither frozen document declares would make the code diverge from its own
 * cited source of truth. So this function pays the real cost of that discipline
 * instead: three different per-state routes to `OFF`, one of them ("integrity or
 * policy failure") more semantically apt than the others, which is the honest
 * state of things until a human resolves the asymmetry at the doc level (the
 * same class of open decision README.md already tracks for the cross-document ID
 * drift on other law/event names).
 *
 * - CALIBRATED: `INTEGRITY_OR_POLICY_FAILURE` — direct, semantically exact.
 * - SHADOW: `ARTIFACT_OR_SCHEMA_INVALID` — the only direct edge to OFF that
 *   exists from SHADOW; not a perfect semantic fit (it's really about the
 *   artifact being malformed, not its signer being untrusted) but it is the one
 *   real, legal, single-hop option.
 * - EXPERIMENTAL: no direct edge to OFF exists at all — two calls,
 *   `SAFETY_OR_COVERAGE_REGRESSION` (-> SHADOW) then `ARTIFACT_OR_SCHEMA_INVALID`
 *   (-> OFF).
 *
 * Idempotent and race-safe for free, not by extra code: `applyEvent()` always
 * re-reads current state before deciding, so sweeping twice (or sweeping a model
 * someone already independently demoted) just produces harmless `allowed:false`
 * log entries on the repeat, never an error or a double-demotion.
 */
export function sweepRevokedKeyDemotions(registry: ModelPromotionRegistry, keyStore: SigningKeyStore, now = new Date()): TransitionLogEntry[] {
  const entries: TransitionLogEntry[] = [];
  for (const affected of findModelsOnRevokedKeys(registry.listAll(), keyStore)) {
    if (affected.state === 'CALIBRATED') {
      entries.push(registry.applyEvent(affected.modelRef, 'INTEGRITY_OR_POLICY_FAILURE', undefined, now));
    } else if (affected.state === 'SHADOW') {
      entries.push(registry.applyEvent(affected.modelRef, 'ARTIFACT_OR_SCHEMA_INVALID', undefined, now));
    } else if (affected.state === 'EXPERIMENTAL') {
      entries.push(registry.applyEvent(affected.modelRef, 'SAFETY_OR_COVERAGE_REGRESSION', undefined, now));
      entries.push(registry.applyEvent(affected.modelRef, 'ARTIFACT_OR_SCHEMA_INVALID', undefined, now));
    }
  }
  return entries;
}
