/**
 * FROZEN_INTEGRATION.md §8.4: "calibration with reassign_every > 0 changes core
 * identity and must be disallowed for overlay-only adapters — only adapter-owned
 * changes are permitted." `reassignEvery` mirrors frozen's own calibration
 * parameter (frozen-ir/calibrate.rs, per FROZEN_REDTEAM_HLD.md §10.1's
 * `reassign_every = 0` rule) — this repo does not call that Rust code, it encodes
 * the same policy as a check on the adapter metadata this repo receives.
 */
export interface DomainAdapterMetadata {
  readonly adapterRef: string;
  readonly domain: string;
  readonly parentCoreRef: string;
  readonly reassignEvery: number;
}

export function isOverlayOnly(metadata: DomainAdapterMetadata): boolean {
  return metadata.reassignEvery === 0;
}
