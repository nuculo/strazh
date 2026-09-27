/**
 * ADAPTIVE_REDTEAM_RUNTIME.md's "Protected Artifact Store" — drawn in the runtime
 * diagram (Normalizer --> ArtifactStore) and named in ARCHITECTURE.md §3.4's Ports
 * list since Phase 0, but never implemented: every adapter has only ever produced
 * synthetic string EvidenceRefs (e.g. `promptfoo:${runId}:${resultId}`) with nothing
 * behind them. This is the real store — content-addressed, so identical bytes always
 * resolve to the same ref (dedup) and a ref can never be forged into pointing at
 * unrelated content.
 *
 * `kind` mirrors rtap:common#/$defs/EvidenceRef's enum exactly.
 */
export type EvidenceKind = 'payload' | 'response' | 'trace' | 'snippet' | 'native-report';

export interface ArtifactRef {
  readonly ref: string;
  readonly kind: EvidenceKind;
}

/**
 * грань №16: a separate ref namespace for model weights, never unioned with
 * `EvidenceKind` — that enum is schema-locked to `rtap:common#/$defs/EvidenceRef`'s
 * five values, and model weights must never silently validate wherever an
 * EvidenceRef is expected (they never enter `Observation.evidenceRefs`).
 */
export interface WeightsRef {
  readonly ref: string;
  readonly kind: 'model-weights';
}

export interface PutArtifactInput {
  readonly assessmentRunId: string;
  readonly kind: EvidenceKind;
  readonly body: string | Uint8Array;
  readonly contentType?: string;
}

/**
 * ARCHITECTURE.md §0: "Local persistence profile: SQLite + protected filesystem
 * artifacts. Production profile: PostgreSQL + S3-compatible artifacts + KMS/Vault."
 * Async by design — a real production implementation (S3) is inherently a network
 * call; the local FilesystemArtifactStore fulfills the same contract over `fs/promises`
 * rather than getting a separate sync-only shape that a network backend couldn't share.
 *
 * `get()`/`exists()` take `{readonly ref: string}` rather than the wider `ArtifactRef`
 * — neither implementation ever reads `.kind`, and this is what lets `WeightsRef`
 * (a different `kind`) round-trip through the same content-addressed storage without
 * a parallel port.
 */
export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactRef>;
  putWeights(body: string | Uint8Array): Promise<WeightsRef>;
  get(ref: { readonly ref: string }): Promise<Buffer>;
  exists(ref: { readonly ref: string }): Promise<boolean>;
}

export class ArtifactNotFoundError extends Error {
  constructor(ref: string) {
    super(`artifact not found: ${ref}`);
    this.name = 'ArtifactNotFoundError';
  }
}

export class MalformedArtifactRefError extends Error {
  constructor(ref: string) {
    super(`malformed artifact ref: ${ref}`);
    this.name = 'MalformedArtifactRefError';
  }
}
