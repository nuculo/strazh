import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { PromptfooOutputFile } from './types.js';
import { scopedExecOptions, type SandboxProfile, type ScopedExecOptions } from '../../execution/sandbox.js';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (bin: string, args: string[], opts: { cwd?: string; sandbox?: SandboxProfile; timeoutMs?: number }) => Promise<ExecResult>;

/** грань №15: scoped via `scopedExecOptions()` — no `sandbox` defaults to `minimalSandboxProfile()`, never full inheritance from this process's own `env`. */
async function defaultExec(bin: string, args: string[], opts: { cwd?: string; sandbox?: SandboxProfile; timeoutMs?: number }): Promise<ExecResult> {
  const scoped = scopedExecOptions(opts.cwd, opts.sandbox, undefined, opts.timeoutMs);
  // Portability without a shell: when `bin` is a JavaScript entrypoint
  // (`.js`/`.cjs`/`.mjs` — e.g. promptfoo's `dist/src/main.js`), spawn the current
  // Node executable (`process.execPath`) with the entrypoint as its own first argv
  // element, then the real args. This is `execFile()` with `shell` left off, so
  // there is no command-line re-parsing and no quoting of paths/args at all —
  // spaces and shell metacharacters in the path or args are inert. It also sidesteps
  // Node's refusal (EINVAL since CVE-2024-27980) to spawn a `.cmd`/`.bat` npm shim
  // directly on Windows: callers point `binPath` at the package's `.js` entrypoint,
  // not its `.cmd` shim. A plain native executable (`promptfoo`, `promptfoo.exe`)
  // still spawns directly, unchanged.
  const isJsEntrypoint = /\.(c|m)?js$/i.test(bin);
  const [file, argv] = isJsEntrypoint ? [process.execPath, [bin, ...args]] : [bin, args];
  return runTolerant(file, argv, scoped);
}

/**
 * promptfoo signals "at least one test case did NOT pass" with process exit code
 * `100` — for a redteam run, a failed test case is precisely a detected weakness (a
 * finding). That is a normal, successful *execution* whose result file was written,
 * not a launch/usage error. `child_process.execFile` treats any non-zero exit as a
 * throw, so without this the adapter would discard every run that actually found
 * something. We therefore treat exit `100` as success (the caller then reads and
 * parses the output file, which promptfoo did write); any other non-zero exit, or a
 * genuine spawn failure (ENOENT/EINVAL), still propagates as an error.
 */
const PROMPTFOO_TESTS_FAILED_EXIT = 100;
async function runTolerant(file: string, argv: string[], scoped: ScopedExecOptions): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, scoped);
    return { stdout, stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code === 'number' && e.code === PROMPTFOO_TESTS_FAILED_EXIT) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    throw err;
  }
}

/**
 * The promptfoo subcommand to invoke. `redteam-run` (default) generates+grades
 * adversarial cases from a `redteam:` config; `eval` runs a plain `tests:` config
 * with the assertions written in it. Both write the SAME `--output` file shape, so
 * the parser downstream is identical — this only selects the verb. `eval` exists so
 * a deterministic probe (e.g. a `not-contains` marker assertion) can be graded
 * without any LLM judge; `redteam run` refuses / hangs on a config that has no
 * `redteam:` block, so the two are not interchangeable at the promptfoo level.
 */
export type PromptfooSubcommand = 'redteam-run' | 'eval';

export interface PromptfooRunOptions {
  readonly configPath: string;
  readonly outputPath: string;
  readonly cwd?: string;
  readonly binPath?: string;
  readonly sandbox?: SandboxProfile;
  /** Defaults to `redteam-run`, preserving the original single-purpose behavior. */
  readonly subcommand?: PromptfooSubcommand;
  /**
   * Bounded execution: kill the spawned promptfoo process after this many ms
   * (SIGKILL). Only that child is affected. Omitted = no timeout. A timed-out run
   * surfaces as `{ ok: false, error: ... }`, so the worker settles the step as a
   * clean failure rather than hanging forever.
   */
  readonly timeoutMs?: number;
}

export type PromptfooRunResult =
  | { readonly ok: true; readonly output: PromptfooOutputFile }
  | { readonly ok: false; readonly error: string };

/**
 * Wraps `promptfoo redteam run`. This is a real, correct implementation of the CLI
 * invocation and output-file parsing — it is not exercised against a live promptfoo
 * process in this repo's test suite, because that would require a real LLM provider
 * and API keys. It is exercised with an injected `execFn` and a fixture output file
 * (test/fixtures/promptfoo-eval-result.json, a hand-verified shape from
 * promptfoo/src/types/index.ts) — the same "real mechanism, fixture-driven
 * verification" split as the Phase 0 law registry.
 *
 * Evidence grade (rtap/README.md's "Evidence levels: Observed / Inferred / Missing"):
 * Observed — the CLI invocation shape and output-file parsing, both exercised by
 * tests against a fixture whose shape is hand-verified against promptfoo's own
 * source. Missing — behavior of a live `promptfoo` process, since none has ever run
 * against this adapter in this repo.
 */
export class PromptfooCliAdapter {
  constructor(
    private readonly execFn: ExecFn = defaultExec,
    private readonly readFileFn: (path: string) => Promise<string> = (p) => readFile(p, 'utf-8'),
  ) {}

  async run(options: PromptfooRunOptions): Promise<PromptfooRunResult> {
    const bin = options.binPath ?? 'promptfoo';
    const verb = (options.subcommand ?? 'redteam-run') === 'eval' ? ['eval'] : ['redteam', 'run'];
    const args = [...verb, '--config', options.configPath, '--output', options.outputPath];

    try {
      await this.execFn(bin, args, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch (err) {
      // A timeout kill (execFile sets err.killed / err.signal) reads as a clean
      // execution failure here, not an unhandled throw — the worker settles the step
      // as FAILED_BEFORE_EFFECT rather than the process hanging.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let raw: string;
    try {
      raw = await this.readFileFn(options.outputPath);
    } catch (err) {
      return { ok: false, error: `promptfoo exited 0 but ${options.outputPath} was not readable: ${err instanceof Error ? err.message : String(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `${options.outputPath} was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }

    // promptfoo's `redteam run --output <file>.json` writes an OutputFile envelope
    // whose `results` is itself an object — the `EvaluateSummaryV3`
    // `{version, timestamp, prompts, results: EvaluateResult[]}` — so the actual
    // per-test-case array lives at `results.results` (verified against a real
    // promptfoo 0.122.0 `--output` file, not guessed). Earlier fixture-based tests
    // used the flat `{results: EvaluateResult[]}` shape. Accept both: read the
    // nested array when `results` is the summary object, the flat array otherwise.
    // Nothing else about the ACL changes — the extracted array feeds the exact same
    // `PromptfooEvaluateResult` normalization as before.
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: `${options.outputPath} did not have the expected {results: [...]} shape` };
    }
    const top = parsed as { evalId?: string; results?: unknown };
    let resultsArray: unknown;
    let evalId: string | undefined = top.evalId;
    if (Array.isArray(top.results)) {
      resultsArray = top.results;
    } else if (typeof top.results === 'object' && top.results !== null && Array.isArray((top.results as { results?: unknown }).results)) {
      resultsArray = (top.results as { results: unknown[] }).results;
    } else {
      return { ok: false, error: `${options.outputPath} did not have the expected {results: [...]} or {results: {results: [...]}} shape` };
    }

    return { ok: true, output: { ...(evalId !== undefined ? { evalId } : {}), results: resultsArray as PromptfooOutputFile['results'] } };
  }
}
