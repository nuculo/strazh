import type { DatabaseSync } from 'node:sqlite';
import type { EffectReceipt } from './effect.js';

/**
 * SQLite-backed §5.2 `EffectReceipt` journal. One row per `effect_id` — a receipt
 * is written once, at dispatch (`outcome: 'UNKNOWN'`), and updated in place as more
 * is learned (acknowledgement, reconciliation) rather than appended-to, since an
 * effect has exactly one current understanding of its own outcome at any time.
 */
export class EffectReceiptStore {
  constructor(private readonly db: DatabaseSync) {}

  record(receipt: EffectReceipt): EffectReceipt {
    this.db
      .prepare(
        `INSERT INTO effect_receipts
           (effect_id, execution_attempt_id, engine_adapter_id, engine_request_id, idempotency_key,
            capability, started_at, acknowledged_at, external_receipt_ref, reconciliation_token, outcome)
         VALUES
           (@effectId, @executionAttemptId, @engineAdapterId, @engineRequestId, @idempotencyKey,
            @capability, @startedAt, @acknowledgedAt, @externalReceiptRef, @reconciliationToken, @outcome)
         ON CONFLICT(effect_id) DO UPDATE SET
           acknowledged_at = @acknowledgedAt,
           external_receipt_ref = @externalReceiptRef,
           reconciliation_token = @reconciliationToken,
           outcome = @outcome`,
      )
      .run({
        effectId: receipt.effectId,
        executionAttemptId: receipt.executionAttemptId,
        engineAdapterId: receipt.engineAdapterId,
        engineRequestId: receipt.engineRequestId,
        idempotencyKey: receipt.idempotencyKey,
        capability: receipt.capability,
        startedAt: receipt.startedAt,
        acknowledgedAt: receipt.acknowledgedAt,
        externalReceiptRef: receipt.externalReceiptRef,
        reconciliationToken: receipt.reconciliationToken,
        outcome: receipt.outcome,
      });
    return receipt;
  }

  get(effectId: string): EffectReceipt | null {
    const row = this.db.prepare(`SELECT * FROM effect_receipts WHERE effect_id = @effectId`).get({ effectId }) as EffectReceiptRow | undefined;
    return row ? rowToReceipt(row) : null;
  }

  /** Null when no receipt was ever recorded for this attempt — §7.2/§13: this alone does not prove the effect never started. */
  getByExecutionAttempt(executionAttemptId: string): EffectReceipt | null {
    const row = this.db.prepare(`SELECT * FROM effect_receipts WHERE execution_attempt_id = @executionAttemptId`).get({ executionAttemptId }) as
      | EffectReceiptRow
      | undefined;
    return row ? rowToReceipt(row) : null;
  }
}

interface EffectReceiptRow {
  effect_id: string;
  execution_attempt_id: string;
  engine_adapter_id: string;
  engine_request_id: string;
  idempotency_key: string | null;
  capability: string;
  started_at: string;
  acknowledged_at: string | null;
  external_receipt_ref: string | null;
  reconciliation_token: string | null;
  outcome: string;
}

function rowToReceipt(row: EffectReceiptRow): EffectReceipt {
  return {
    effectId: row.effect_id,
    executionAttemptId: row.execution_attempt_id,
    engineAdapterId: row.engine_adapter_id,
    engineRequestId: row.engine_request_id,
    idempotencyKey: row.idempotency_key,
    capability: row.capability as EffectReceipt['capability'],
    startedAt: row.started_at,
    acknowledgedAt: row.acknowledged_at,
    externalReceiptRef: row.external_receipt_ref,
    reconciliationToken: row.reconciliation_token,
    outcome: row.outcome as EffectReceipt['outcome'],
  };
}
