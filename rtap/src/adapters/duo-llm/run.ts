import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { checkCapabilities, type EngineAdapterCapabilities, type EngineAdapterCapability } from '../capability.js';
import type { DuoLlmRedteamReport } from './types.js';
import { scopedExecOptions, type SandboxProfile } from '../../execution/sandbox.js';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (bin: string, args: string[], opts: { cwd?: string; sandbox?: SandboxProfile }) => Promise<ExecResult>;

/** грань №15: scoped via `scopedExecOptions()` — no `sandbox` defaults to `minimalSandboxProfile()`, never full inheritance from this process's own `env`. */
async function defaultExec(bin: string, args: string[], opts: { cwd?: string; sandbox?: SandboxProfile }): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(bin, args, scopedExecOptions(opts.cwd, opts.sandbox));
  return { stdout, stderr };
}

export interface DuoLlmRunOptions {
  readonly purpose?: string;
  readonly plugins?: readonly string[];
  readonly strategies?: readonly string[];
  readonly domains?: readonly string[];
  readonly attacksPerPlugin?: number;
  readonly outputPath: string;
  readonly cwd?: string;
  readonly binPath?: string;
  readonly sandbox?: SandboxProfile;
}

export type DuoLlmRunResult =
  | { readonly ok: true; readonly report: DuoLlmRedteamReport }
  | { readonly ok: false; readonly error: string; readonly rejectedCapabilities?: readonly EngineAdapterCapability[] };

/**
 * ARCHITECTURE.md §9 Phase R's four gates, as ground truth verified against the
 * actual `duo-agents` source (types.ts's doc comment has the exact citations) and a
 * real captured report (`test/fixtures/duo-llm-redteam-report.json`) — not
 * aspirational, not a config flag someone can flip. All four are false today:
 *
 * - `realTargetProvider`: false — `response` comes from `simulate_ai_response()`, a
 *   private 4-branch keyword-matched stub; no HTTP client exists in `src/redteam/`.
 * - `strategiesConnected`: false — `strategy_id` is `null` on every real attack
 *   regardless of `--strategies`/`--domains`; `amplify_attacks()` is never called.
 * - `mandatoryGrading`: false — 4 of 18 plugins have a real grader; the rest get
 *   `UNGRADED_SENTINEL`'s `pass: true, score: 1.0` default, not an explicit
 *   UNVERIFIED at the source (RTAP's own ACL supplies that instead, see parse.ts).
 * - `deterministicScoring`: false — `PluginRiskScore.worst_strategy` is a
 *   `HashMap`+`max_by` tie-break, non-deterministic across process runs; no field
 *   anywhere in the DTO carries a schema/format version.
 *
 * Independently of duo-agents' own state, `EXECUTION_SAFETY_RECOVERY.md` §"Изменения
 * сначала применяются к Promptfoo... Duo, MCP и будущие engines admit только после
 * прохождения тех же contracts" — RTAP's own Phase 4.5 execution-safety admission
 * gate (ExecutionAttempt binding, lease fencing, EffectReceipt) does not exist yet
 * either, so this adapter would not be admissible to real dispatch even if
 * duo-agents fixed all four gates on its own side tomorrow.
 *
 * Evidence grade (rtap/README.md's "Evidence levels: Observed / Inferred / Missing"):
 * Observed — all four `DECLARED_CAPABILITIES` values, each independently checked
 * against duo-agents' actual source (types.ts's own doc comment carries the exact
 * citations) and a real captured report, not assumed. Inferred — that RTAP's own
 * not-yet-built Phase 4.5 admission gate would in fact also block this adapter even
 * if duo-agents fixed all four gates; reasoned from the gate's stated design, not
 * observed against a real gate, since none exists yet to check against.
 */
export const DECLARED_CAPABILITIES: EngineAdapterCapabilities = {
  realTargetProvider: false,
  strategiesConnected: false,
  mandatoryGrading: false,
  deterministicScoring: false,
};

export const REQUIRED_CAPABILITIES: readonly EngineAdapterCapability[] = [
  'realTargetProvider',
  'strategiesConnected',
  'mandatoryGrading',
  'deterministicScoring',
];

/**
 * Wraps `duo-agents redteam --purpose <p> [--plugins <csv>] [--strategies <csv>]
 * [--domains <csv>] --attacks-per-plugin <n> --format json --output <file>` — the
 * real invocation shape, verified by actually running the built binary
 * (`duo-agents/target/release/duo-agents redteam --help`), not guessed from CLI
 * docs. `run()` checks `DECLARED_CAPABILITIES` against `REQUIRED_CAPABILITIES`
 * *before* touching `execFn` at all — rejected before execution, not discovered as
 * a runtime failure (`redteam.adapter/unsupported-capability-is-rejected`). Since
 * every required capability is false today, this always rejects; the invocation
 * logic below is real and correct so flipping any capability to true later is a
 * one-line change here, not a rewrite — it is not exercised by tests via a live
 * `duo-agents` binary, same "real mechanism, fixture-driven verification" split as
 * every other CLI adapter in this repo.
 */
export class DuoLlmCliAdapter {
  constructor(
    private readonly execFn: ExecFn = defaultExec,
    private readonly readFileFn: (path: string) => Promise<string> = (p) => readFile(p, 'utf-8'),
  ) {}

  async run(options: DuoLlmRunOptions): Promise<DuoLlmRunResult> {
    const capabilityCheck = checkCapabilities(DECLARED_CAPABILITIES, REQUIRED_CAPABILITIES);
    if (!capabilityCheck.permitted) {
      return {
        ok: false,
        error: `DuoLlmAdapter is quarantined: missing capabilities [${capabilityCheck.missing.join(', ')}] — see ARCHITECTURE.md §9 Phase R`,
        rejectedCapabilities: capabilityCheck.missing,
      };
    }

    const bin = options.binPath ?? 'duo-agents';
    const args = ['redteam', '--purpose', options.purpose ?? 'AI assistant', '--attacks-per-plugin', String(options.attacksPerPlugin ?? 5), '--format', 'json'];
    if (options.plugins && options.plugins.length > 0) args.push('--plugins', options.plugins.join(','));
    if (options.strategies && options.strategies.length > 0) args.push('--strategies', options.strategies.join(','));
    if (options.domains && options.domains.length > 0) args.push('--domains', options.domains.join(','));
    args.push('--output', options.outputPath);

    try {
      await this.execFn(bin, args, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}) });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let raw: string;
    try {
      raw = await this.readFileFn(options.outputPath);
    } catch (err) {
      return { ok: false, error: `duo-agents exited 0 but ${options.outputPath} was not readable: ${err instanceof Error ? err.message : String(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `${options.outputPath} was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { results?: unknown }).results)) {
      return { ok: false, error: `${options.outputPath} did not have the expected RedteamReport shape` };
    }

    return { ok: true, report: parsed as DuoLlmRedteamReport };
  }
}
