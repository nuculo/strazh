export interface ProbeCatalogEntry {
  readonly probeId: string;
  /** Mandatory policy probes cannot be ranked away — ARCHITECTURE.md §8, redteam.planner/mandatory-probes-cannot-be-ranked-away. */
  readonly mandatory: boolean;
}
