import type { DatabaseSync } from 'node:sqlite';
import { validate } from '../schemas/index.js';

export interface ObservationRecord {
  readonly id: string;
  readonly assessmentRunId: string;
  readonly targetId: string;
  readonly probeId: string;
  readonly verdict: string;
  readonly [key: string]: unknown;
}

/**
 * Persists Observations that have already been schema-validated by their producing
 * adapter's parse step — this store re-validates anyway (redteam.observation/every-
 * observation-has-provenance must hold at the storage boundary too, not just at
 * parse time) and refuses to persist an invalid one.
 */
export class ObservationStore {
  constructor(private readonly db: DatabaseSync) {}

  put(observation: ObservationRecord, now = new Date()): ObservationRecord {
    const check = validate('rtap:observation', observation);
    if (!check.valid) {
      throw new Error(`Refusing to store an invalid Observation: ${check.errors.join('; ')}`);
    }
    this.db
      .prepare(
        `INSERT INTO observations (id, assessment_run_id, target_id, probe_id, verdict, body_json, created_at)
         VALUES (@id, @assessmentRunId, @targetId, @probeId, @verdict, @bodyJson, @createdAt)`,
      )
      .run({
        id: observation.id,
        assessmentRunId: observation.assessmentRunId,
        targetId: observation.targetId,
        probeId: observation.probeId,
        verdict: observation.verdict,
        bodyJson: JSON.stringify(observation),
        createdAt: now.toISOString(),
      });
    return observation;
  }

  listByAssessmentRun(assessmentRunId: string): ObservationRecord[] {
    const rows = this.db
      .prepare(`SELECT body_json FROM observations WHERE assessment_run_id = @assessmentRunId ORDER BY created_at ASC`)
      .all({ assessmentRunId }) as { body_json: string }[];
    return rows.map((r) => JSON.parse(r.body_json) as ObservationRecord);
  }
}
