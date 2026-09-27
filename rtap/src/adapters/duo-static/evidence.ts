import type { ArtifactStore } from '../../artifacts/store.js';
import { materializeEvidence, type EvidenceBody } from '../../artifacts/materialize.js';
import type { DuoStaticFinding, DuoStaticScanResult } from './types.js';
import type { ParsedObservation } from './parse.js';

/**
 * The real bytes behind a duo-static `ParsedObservation`'s evidence.
 * `finding.code_snippet` (when the scanner captured one — it's nullable, and this
 * only stores a `snippet` ref when it's actually present, rather than fabricating
 * one) becomes the `snippet` artifact; the whole `scan` record becomes the
 * `native-report` artifact. `scan` is shared by every finding in the same scan —
 * calling this once per finding writes the identical bytes repeatedly, which
 * `materializeEvidence()`'s content-addressing collapses to the same ref at no
 * extra storage cost, mirroring the original synthetic ref's own
 * one-ref-per-scan shape (`duo-static:${scan.id}:report`).
 */
export async function materializeDuoStaticEvidence(store: ArtifactStore, parsed: ParsedObservation, finding: DuoStaticFinding, scan: DuoStaticScanResult): Promise<ParsedObservation> {
  const bodies: EvidenceBody[] = [];
  if (finding.code_snippet !== null) {
    bodies.push({ kind: 'snippet', body: finding.code_snippet });
  }
  bodies.push({ kind: 'native-report', body: JSON.stringify(scan) });

  const refs = await materializeEvidence(store, parsed.assessmentRunId, bodies);
  return { ...parsed, evidenceRefs: refs };
}
