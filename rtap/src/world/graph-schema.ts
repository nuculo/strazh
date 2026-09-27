/**
 * FROZEN_INTEGRATION.md §3.1 Immutable GraphSchema. "Schema is compiled into
 * ModelSnapshot. Illegal relations are rejected before a world mutation."
 *
 * Only PROBE_TESTS_TARGET, TARGET_EXPOSES_FINDING and their entity types are
 * actually derivable from the event payload shape this repo's own adapters
 * commit today ({targetId, probeId, verdict} — see observation-event.ts). The
 * rest of the vocabulary (Strategy, SecurityControl, Domain, ModelVersion, and
 * the relation types that reference them) is declared because the schema is
 * fixed platform vocabulary, not per-source-of-events vocabulary — but nothing
 * in this repo derives them yet. That gap is real, not hidden: see reducer.ts.
 */
export type EntityType = 'Target' | 'ProbeClass' | 'Strategy' | 'Finding' | 'SecurityControl' | 'Domain' | 'ModelVersion';

export type RelationType =
  | 'PROBE_TESTS_TARGET'
  | 'STRATEGY_DELIVERS_PROBE'
  | 'TARGET_EXPOSES_FINDING'
  | 'FINDING_CORRELATES_WITH'
  | 'CONTROL_MITIGATES_FINDING'
  | 'TARGET_BELONGS_TO_DOMAIN'
  | 'TARGET_USES_MODEL';

export const LEGAL_RELATIONS: Readonly<Record<RelationType, readonly [EntityType, EntityType]>> = {
  PROBE_TESTS_TARGET: ['ProbeClass', 'Target'],
  STRATEGY_DELIVERS_PROBE: ['Strategy', 'ProbeClass'],
  TARGET_EXPOSES_FINDING: ['Target', 'Finding'],
  FINDING_CORRELATES_WITH: ['Finding', 'Finding'],
  CONTROL_MITIGATES_FINDING: ['SecurityControl', 'Finding'],
  TARGET_BELONGS_TO_DOMAIN: ['Target', 'Domain'],
  TARGET_USES_MODEL: ['Target', 'ModelVersion'],
};

export interface RelationCandidate {
  readonly type: RelationType;
  readonly sourceType: EntityType;
  readonly targetType: EntityType;
}

/** True iff (sourceType, targetType) is the declared pair for `type`. Nothing merges into world state without passing this. */
export function isLegalRelation(candidate: RelationCandidate): boolean {
  const [expectedSource, expectedTarget] = LEGAL_RELATIONS[candidate.type];
  return candidate.sourceType === expectedSource && candidate.targetType === expectedTarget;
}
