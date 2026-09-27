/**
 * Compatibility checks between a compiled core model and a domain adapter, and
 * between a FeatureSnapshot and the WorldBinding it is about to be applied against.
 * FROZEN_INTEGRATION.md §9, §10.1 (`model-and-adapter-must-fit`,
 * `feature-version-mismatch-is-rejected`).
 */

export interface ModelSnapshotLike {
  readonly modelRef: string;
  readonly format: 'FZM' | 'FZA';
  readonly featureSchemaVersion: string;
  readonly parentCoreRef?: string | null;
}

/**
 * An FZA adapter "fits" a core iff it declares that core as its parent and they agree
 * on feature schema. A core always fits itself (identity case, format FZM never has a
 * parentCoreRef requirement).
 */
export function modelAdapterFits(core: ModelSnapshotLike, adapter: ModelSnapshotLike): boolean {
  if (adapter.format !== 'FZA') return false;
  if (core.format !== 'FZM') return false;
  if (adapter.parentCoreRef !== core.modelRef) return false;
  if (adapter.featureSchemaVersion !== core.featureSchemaVersion) return false;
  return true;
}

/** A produced V60 is only accepted if its declared feature schema exactly matches the active one. */
export function isFeatureVersionAccepted(vectorFeatureSchemaVersion: string, activeFeatureSchemaVersion: string): boolean {
  return vectorFeatureSchemaVersion === activeFeatureSchemaVersion;
}
