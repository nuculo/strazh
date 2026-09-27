import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { DuoStaticScanResult } from './types.js';
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

export interface DuoStaticRunOptions {
  readonly path: string;
  readonly outputPath: string;
  readonly minSeverity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly cwd?: string;
  readonly binPath?: string;
  readonly sandbox?: SandboxProfile;
}

export type DuoStaticRunResult =
  | { readonly ok: true; readonly scan: DuoStaticScanResult; readonly summaryMismatch: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Wraps `duo-agents scan --path <path> --format json [--output <file>]
 * [--min-severity <level>]`. This is the *real* invocation shape — not the
 * `scan-json` alias documented in duo-agents' own README (that's a `run.sh` shell
 * wrapper, not a binary subcommand) and not the `duo-agents scan <path> --mr ...`
 * form the GitLab CI docs recommend, which wiki/Arch_duo-agents/ARCHITECTURE.md
 * confirms actually fails with exit code 2 because `--path` is a named option, not
 * positional. Same "real mechanism, fixture-driven verification" split as
 * PromptfooCliAdapter — not exercised against a live `duo-agents` binary here.
 *
 * Evidence grade (rtap/README.md's "Evidence levels: Observed / Inferred / Missing"):
 * Observed — the correct invocation shape, and that both alternative forms actually
 * fail, both checked against wiki/Arch_duo-agents/ARCHITECTURE.md rather than assumed
 * from duo-agents' own README. Missing — behavior of a live `duo-agents` binary,
 * since none has ever run against this adapter in this repo.
 */
export class DuoStaticCliAdapter {
  constructor(
    private readonly execFn: ExecFn = defaultExec,
    private readonly readFileFn: (path: string) => Promise<string> = (p) => readFile(p, 'utf-8'),
  ) {}

  async run(options: DuoStaticRunOptions): Promise<DuoStaticRunResult> {
    const bin = options.binPath ?? 'duo-agents';
    const args = ['scan', '--path', options.path, '--format', 'json'];
    if (options.outputPath) args.push('--output', options.outputPath);
    if (options.minSeverity) args.push('--min-severity', options.minSeverity);

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

    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { findings?: unknown }).findings) || !(parsed as { summary?: unknown }).summary) {
      return { ok: false, error: `${options.outputPath} did not have the expected ScanResult shape` };
    }

    const scan = parsed as DuoStaticScanResult;
    const actualTotal = scan.findings.length;
    // See types.ts's doc comment: summary is computed from the pre-filter set and
    // routinely disagrees with the emitted findings array. Reported, not hidden.
    const summaryMismatch = scan.summary.total_findings !== actualTotal;

    return { ok: true, scan, summaryMismatch };
  }
}
