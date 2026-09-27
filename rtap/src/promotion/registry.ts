import type { DatabaseSync } from 'node:sqlite';
import { attemptModelTransition, type PromotionEvent, type PromotionState, type SignatureGate } from './types.js';
import type { SignedModelArtifact } from '../training/model-artifact.js';

export interface PromotionRecord {
  readonly modelRef: string;
  readonly state: PromotionState;
  readonly artifact: SignedModelArtifact;
  readonly updatedAt: string;
}

export interface TransitionLogEntry {
  readonly modelRef: string;
  readonly event: PromotionEvent;
  readonly from: PromotionState;
  readonly to: PromotionState;
  readonly allowed: boolean;
  readonly reason: string;
  readonly at: string;
}

/**
 * SQLite-backed model promotion registry. Starts a newly-admitted artifact at OFF —
 * `admit()` does not itself promote to SHADOW, it only makes the artifact known;
 * moving to SHADOW is the `MODEL_ADMITTED` event applied explicitly, so "admitted"
 * and "promoted" stay two separate, auditable actions even though they're often
 * called together (see `admitAndPromoteToShadow`).
 */
export class ModelPromotionRegistry {
  constructor(private readonly db: DatabaseSync) {}

  admit(artifact: SignedModelArtifact, now = new Date()): PromotionRecord {
    const existing = this.get(artifact.modelRef);
    if (existing) return existing;
    const record: PromotionRecord = { modelRef: artifact.modelRef, state: 'OFF', artifact, updatedAt: now.toISOString() };
    this.db
      .prepare(`INSERT INTO model_promotions (model_ref, state, artifact_json, updated_at) VALUES (@modelRef, @state, @artifactJson, @updatedAt)`)
      .run({ modelRef: record.modelRef, state: record.state, artifactJson: JSON.stringify(artifact), updatedAt: record.updatedAt });
    return record;
  }

  get(modelRef: string): PromotionRecord | null {
    const row = this.db.prepare(`SELECT * FROM model_promotions WHERE model_ref = @modelRef`).get({ modelRef }) as
      | { model_ref: string; state: string; artifact_json: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return { modelRef: row.model_ref, state: row.state as PromotionState, artifact: JSON.parse(row.artifact_json), updatedAt: row.updated_at };
  }

  /**
   * Applies `event` to `modelRef`'s current state. Illegal transitions are rejected
   * and logged, never silently coerced — "the model cannot promote itself" extends
   * to the registry refusing to invent a transition nobody declared.
   *
   * грань №16: `signature` gates `MODEL_ADMITTED` specifically (see
   * `attemptModelTransition()`/`SIGNATURE_GATED_EVENTS` in `types.ts`) and is
   * embedded HERE, not in a wrapper above this method — the actual crypto
   * verification (async, resolves key material via `SecretProvider`) must still
   * happen in an async caller before this call, since this method stays
   * synchronous over `node:sqlite`; what moves is *where the refusal decision is
   * enforced*, so a caller cannot bypass the gate by calling `applyEvent()`
   * directly and forgetting to check a `verify()` result first. Every other event
   * is completely unaffected — `signature` is ignored unless `event` is gated.
   */
  applyEvent(modelRef: string, event: PromotionEvent, signature?: SignatureGate, now = new Date()): TransitionLogEntry {
    const current = this.get(modelRef);
    if (!current) {
      throw new Error(`Cannot apply ${event} to unknown modelRef ${modelRef} — admit() it first`);
    }
    const result = attemptModelTransition(current.state, event, signature);
    const entry: TransitionLogEntry = {
      modelRef,
      event,
      from: result.from,
      to: result.to,
      allowed: result.allowed,
      reason: result.allowed ? 'transition permitted by declared state graph' : (result.reason ?? `no declared transition for ${event} from ${result.from}`),
      at: now.toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO model_promotion_log (model_ref, event, from_state, to_state, allowed, reason, at)
         VALUES (@modelRef, @event, @fromState, @toState, @allowed, @reason, @at)`,
      )
      .run({ modelRef, event, fromState: entry.from, toState: entry.to, allowed: entry.allowed ? 1 : 0, reason: entry.reason, at: entry.at });

    if (result.allowed) {
      this.db
        .prepare(`UPDATE model_promotions SET state = @state, updated_at = @updatedAt WHERE model_ref = @modelRef`)
        .run({ state: result.to, updatedAt: entry.at, modelRef });
    }

    return entry;
  }

  /** Every admitted model, ordered by `modelRef` for a stable, predictable listing — `promotion/cli.ts`'s `list` subcommand exists precisely because there was previously no way to see this without querying the database directly. */
  listAll(): PromotionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM model_promotions ORDER BY model_ref ASC`).all() as {
      model_ref: string;
      state: string;
      artifact_json: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({ modelRef: row.model_ref, state: row.state as PromotionState, artifact: JSON.parse(row.artifact_json), updatedAt: row.updated_at }));
  }

  history(modelRef: string): TransitionLogEntry[] {
    const rows = this.db.prepare(`SELECT * FROM model_promotion_log WHERE model_ref = @modelRef ORDER BY at ASC`).all({ modelRef }) as {
      model_ref: string;
      event: string;
      from_state: string;
      to_state: string;
      allowed: number;
      reason: string;
      at: string;
    }[];
    return rows.map((r) => ({
      modelRef: r.model_ref,
      event: r.event as PromotionEvent,
      from: r.from_state as PromotionState,
      to: r.to_state as PromotionState,
      allowed: r.allowed === 1,
      reason: r.reason,
      at: r.at,
    }));
  }
}
