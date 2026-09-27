import type { DatabaseSync } from 'node:sqlite';
import type { AuthorizationReceipt } from './authorization.js';

/** SQLite-backed §8.1 `AuthorizationReceipt` journal. Immutable once issued — there is no update method, only `record()` (insert) and reads. */
export class AuthorizationReceiptStore {
  constructor(private readonly db: DatabaseSync) {}

  record(receipt: AuthorizationReceipt): AuthorizationReceipt {
    this.db
      .prepare(
        `INSERT INTO authorization_receipts
           (authorization_id, campaign_id, assessment_run_id, run_step_id, operation_family, target_snapshot_ref,
            adapter_id, adapter_version, adapter_capability_digest, policy_revision,
            sandbox_profile_ref, egress_policy_ref, approved_at, expires_at)
         VALUES
           (@authorizationId, @campaignId, @assessmentRunId, @runStepId, @operationFamily, @targetSnapshotRef,
            @adapterId, @adapterVersion, @adapterCapabilityDigest, @policyRevision,
            @sandboxProfileRef, @egressPolicyRef, @approvedAt, @expiresAt)`,
      )
      .run({
        authorizationId: receipt.authorizationId,
        campaignId: receipt.campaignId,
        assessmentRunId: receipt.assessmentRunId,
        runStepId: receipt.runStepId,
        operationFamily: receipt.operationFamily,
        targetSnapshotRef: receipt.targetSnapshotRef,
        adapterId: receipt.adapterIdentity.engineAdapterId,
        adapterVersion: receipt.adapterIdentity.engineAdapterVersion,
        adapterCapabilityDigest: receipt.adapterCapabilityDigest,
        policyRevision: receipt.policyRevision,
        sandboxProfileRef: receipt.sandboxProfileRef,
        egressPolicyRef: receipt.egressPolicyRef,
        approvedAt: receipt.approvedAt,
        expiresAt: receipt.expiresAt,
      });
    return receipt;
  }

  get(authorizationId: string): AuthorizationReceipt | null {
    const row = this.db.prepare(`SELECT * FROM authorization_receipts WHERE authorization_id = @authorizationId`).get({ authorizationId }) as
      | AuthorizationReceiptRow
      | undefined;
    return row ? rowToReceipt(row) : null;
  }

  listByRunStep(runStepId: string): AuthorizationReceipt[] {
    const rows = this.db
      .prepare(`SELECT * FROM authorization_receipts WHERE run_step_id = @runStepId ORDER BY approved_at ASC`)
      .all({ runStepId }) as unknown as AuthorizationReceiptRow[];
    return rows.map(rowToReceipt);
  }
}

interface AuthorizationReceiptRow {
  authorization_id: string;
  campaign_id: string;
  assessment_run_id: string;
  run_step_id: string;
  operation_family: string;
  target_snapshot_ref: string;
  adapter_id: string;
  adapter_version: string;
  adapter_capability_digest: string;
  policy_revision: string;
  sandbox_profile_ref: string | null;
  egress_policy_ref: string | null;
  approved_at: string;
  expires_at: string;
}

function rowToReceipt(row: AuthorizationReceiptRow): AuthorizationReceipt {
  return {
    authorizationId: row.authorization_id,
    campaignId: row.campaign_id,
    assessmentRunId: row.assessment_run_id,
    runStepId: row.run_step_id,
    operationFamily: row.operation_family,
    targetSnapshotRef: row.target_snapshot_ref,
    adapterIdentity: { engineAdapterId: row.adapter_id, engineAdapterVersion: row.adapter_version },
    adapterCapabilityDigest: row.adapter_capability_digest,
    policyRevision: row.policy_revision,
    sandboxProfileRef: row.sandbox_profile_ref,
    egressPolicyRef: row.egress_policy_ref,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
  };
}
