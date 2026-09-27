import type { ArtifactStore } from '../../artifacts/store.js';
import { materializeEvidence, type EvidenceBody } from '../../artifacts/materialize.js';
import type { DuoLlmRedteamReport, DuoLlmTestResult } from './types.js';
import type { ParsedObservation } from './parse.js';

/**
 * The real bytes behind a duo-llm `ParsedObservation`'s evidence: `attack.prompt`
 * (the actual attack text sent) as `payload`, `response` (the actual — simulated,
 * see types.ts's doc comment — model output) as `response`, and the whole
 * `report` as `native-report`, mirroring the original synthetic ref's
 * one-ref-per-report shape (`duo-llm:${report.id}:report`) — content-addressing
 * collapses repeated writes of the same `report` bytes across every result to one
 * ref, same as duo-static's scan-level sharing.
 */
export async function materializeDuoLlmEvidence(store: ArtifactStore, parsed: ParsedObservation, result: DuoLlmTestResult, report: DuoLlmRedteamReport): Promise<ParsedObservation> {
  const bodies: EvidenceBody[] = [
    { kind: 'payload', body: result.attack.prompt },
    { kind: 'response', body: result.response },
    { kind: 'native-report', body: JSON.stringify(report) },
  ];
  const refs = await materializeEvidence(store, parsed.assessmentRunId, bodies);
  return { ...parsed, evidenceRefs: refs };
}
