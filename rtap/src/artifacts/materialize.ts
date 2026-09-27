import type { ArtifactRef, ArtifactStore, EvidenceKind } from './store.js';

export interface EvidenceBody {
  readonly kind: EvidenceKind;
  readonly body: string | Uint8Array;
  readonly contentType?: string;
}

/**
 * Audit finding #5: `ArtifactStore` (Phase 7) and every adapter's `parse.ts` ACL
 * have existed side by side since Phase 7 without ever being connected — every
 * adapter has only ever produced synthetic string EvidenceRefs (see `store.ts`'s
 * own doc comment) with nothing behind them; `store.get()` on one throws
 * `MalformedArtifactRefError`, not "not found," because they were never even
 * shaped like a real ref. This is the missing connection: given the real bytes an
 * adapter's native result actually carries, write each to `store` and return real
 * content-addressed refs in the same order — same-content bodies converge to the
 * same ref for free (`FilesystemArtifactStore`'s own content-addressing), so a
 * caller reusing one body across multiple observations (e.g. a whole scan report
 * shared by every finding in it) pays no duplication cost.
 */
export async function materializeEvidence(store: ArtifactStore, assessmentRunId: string, bodies: readonly EvidenceBody[]): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  for (const b of bodies) {
    refs.push(await store.put({ assessmentRunId, kind: b.kind, body: b.body, ...(b.contentType !== undefined ? { contentType: b.contentType } : {}) }));
  }
  return refs;
}
