/**
 * Minimal slice of duo-agents' real static-scan output shape that this adapter
 * actually reads. Field names and semantics verified against
 * `duo-agents/src/scan/mod.rs` (`Finding`, `ScanResult`, `ScanSummary` structs) and
 * two real captured scans (`duo-agents/gitlabhq_scan.json`,
 * `duo-agents/public/demo_report.json`) — not guessed. Same ACL discipline as
 * `../promptfoo/types.ts`: this repo does not import duo-agents' own Rust types,
 * only the JSON shape it writes.
 *
 * `Finding` has no id, no confidence/score and no taint source/sink fields, despite
 * README claims of taint analysis — wiki/Arch_duo-agents/ARCHITECTURE.md documents
 * the scan plugins as line-regex substring matching, not AST/taint analysis. This
 * adapter's verdict mapping (parse.ts) is deliberately conservative because of that.
 */
export type DuoSeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';

export interface DuoStaticFinding {
  readonly plugin: string;
  readonly severity: DuoSeverity;
  readonly title: string;
  readonly description: string;
  readonly file: string;
  readonly line: number | null;
  readonly code_snippet: string | null;
  readonly suggestion: string | null;
  readonly cwe: string | null;
}

export interface DuoStaticScanSummary {
  readonly total_files: number;
  readonly total_findings: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly risk_score: number;
}

export interface DuoStaticScanResult {
  readonly id: string;
  readonly timestamp: string;
  readonly target: string;
  readonly duration_ms: number;
  readonly findings: DuoStaticFinding[];
  /**
   * Known-unreliable: main.rs filters `findings` by --min-severity but recomputes
   * this from the *unfiltered* set, so `summary.total_findings` (and per-severity
   * counts) routinely disagree with `findings.length` — confirmed against a real
   * scan (9159 vs 1684). Never trust this for counts; parse.ts derives everything
   * from `findings` directly.
   */
  readonly summary: DuoStaticScanSummary;
}
