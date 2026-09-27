import type { DatabaseSync } from 'node:sqlite';
import { evaluateSwapTiming, type AdapterSwapRequest, type SwapDecision } from './swap.js';
import { isOverlayOnly, type DomainAdapterMetadata } from './metadata.js';
import type { AdmissionEvaluation } from './matrix.js';

export interface DomainAdapterLogEntry {
  readonly domain: string;
  readonly fromAdapterRef: string | null;
  readonly toAdapterRef: string | null;
  readonly reason: string;
  readonly allowed: boolean;
  readonly at: string;
}

/**
 * SQLite-backed active-adapter-per-domain state, with full swap history for
 * rollback. `swap()` is the single enforcement point for every FROZEN_INTEGRATION.md
 * §8.4 admission rule together: run-boundary timing, diagonal cross-domain gain,
 * and overlay-only calibration (`reassignEvery === 0`) — a caller cannot bypass any
 * of them by calling a lower-level method, because there isn't one that mutates
 * `domain_adapter_state` other than this.
 */
export class DomainAdapterRegistry {
  constructor(private readonly db: DatabaseSync) {}

  getActive(domain: string): string | null {
    const row = this.db.prepare(`SELECT active_adapter_ref FROM domain_adapter_state WHERE domain = @domain`).get({ domain }) as
      | { active_adapter_ref: string | null }
      | undefined;
    return row?.active_adapter_ref ?? null;
  }

  swap(
    request: AdapterSwapRequest,
    admission: AdmissionEvaluation | null,
    metadata: DomainAdapterMetadata | null,
    now = new Date(),
  ): SwapDecision {
    const from = this.getActive(request.domain);

    const timingDecision = evaluateSwapTiming(request);
    if (!timingDecision.allowed) {
      this.logEntry(request.domain, from, request.newAdapterRef, timingDecision.reason, false, now);
      return timingDecision;
    }

    if (request.newAdapterRef !== null) {
      if (!admission || !admission.admitted) {
        const reason = `adapter not admitted: ${admission ? admission.reasonCodes.join(', ') : 'no admission evaluation provided'}`;
        this.logEntry(request.domain, from, request.newAdapterRef, reason, false, now);
        return { allowed: false, reason };
      }
      if (!metadata || metadata.adapterRef !== request.newAdapterRef || !isOverlayOnly(metadata)) {
        const reason = !metadata || metadata.adapterRef !== request.newAdapterRef
          ? 'no matching adapter metadata provided'
          : `adapter has reassignEvery=${metadata.reassignEvery} — only overlay-only (reassignEvery=0) adapters are admitted`;
        this.logEntry(request.domain, from, request.newAdapterRef, reason, false, now);
        return { allowed: false, reason };
      }
    }

    this.setActive(request.domain, request.newAdapterRef, now);
    this.logEntry(request.domain, from, request.newAdapterRef, 'admitted swap', true, now);
    return { allowed: true, reason: 'swapped' };
  }

  /**
   * Reverts a domain to whatever was active immediately before its current
   * adapter. With exactly one prior swap, that "before" state is the implicit
   * start (no adapter, `null`) — not logged as its own entry, but a real and valid
   * rollback target; only a domain with *zero* swaps has nothing to revert to.
   * Itself logged as an allowed run-boundary swap — a rollback is not a bypass of
   * the swap history, it is one more entry in it.
   */
  rollback(domain: string, now = new Date()): SwapDecision {
    const allowedHistory = this.history(domain).filter((e) => e.allowed);
    if (allowedHistory.length === 0) {
      return { allowed: false, reason: 'no prior adapter state to roll back to' };
    }
    const previous = allowedHistory.length === 1 ? null : allowedHistory[allowedHistory.length - 2]!.toAdapterRef;
    const from = this.getActive(domain);
    this.setActive(domain, previous, now);
    this.logEntry(domain, from, previous, 'rollback', true, now);
    return { allowed: true, reason: 'rolled back' };
  }

  history(domain: string): DomainAdapterLogEntry[] {
    const rows = this.db.prepare(`SELECT * FROM domain_adapter_log WHERE domain = @domain ORDER BY at ASC, id ASC`).all({ domain }) as {
      domain: string;
      from_adapter_ref: string | null;
      to_adapter_ref: string | null;
      reason: string;
      allowed: number;
      at: string;
    }[];
    return rows.map((r) => ({
      domain: r.domain,
      fromAdapterRef: r.from_adapter_ref,
      toAdapterRef: r.to_adapter_ref,
      reason: r.reason,
      allowed: r.allowed === 1,
      at: r.at,
    }));
  }

  private setActive(domain: string, adapterRef: string | null, now: Date): void {
    const updatedAt = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO domain_adapter_state (domain, active_adapter_ref, updated_at) VALUES (@domain, @adapterRef, @updatedAt)
         ON CONFLICT(domain) DO UPDATE SET active_adapter_ref = @adapterRef, updated_at = @updatedAt`,
      )
      .run({ domain, adapterRef, updatedAt });
  }

  private logEntry(domain: string, from: string | null, to: string | null, reason: string, allowed: boolean, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO domain_adapter_log (domain, from_adapter_ref, to_adapter_ref, reason, allowed, at)
         VALUES (@domain, @from, @to, @reason, @allowed, @at)`,
      )
      .run({ domain, from, to, reason, allowed: allowed ? 1 : 0, at: now.toISOString() });
  }
}
