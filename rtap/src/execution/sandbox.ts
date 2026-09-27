/**
 * грань №15 (`Грани Arch_claude`): "approval answers only 'can this run at all,' it
 * does not automatically scope every subsequent operation." The concrete gap this
 * closes — confirmed by reading `defaultExec()` in every adapter's `run.ts` directly:
 * `execFile(bin, args, { cwd, maxBuffer })` with no `env`, no `uid`/`gid` — a spawned
 * child process inherited the worker's *entire* environment and privileges. This is
 * privilege/env scoping only, not full sandboxing (no filesystem or network
 * isolation) — the mechanism decided on after weighing it against a container
 * runtime (a hard new dependency this project doesn't otherwise have) and Linux
 * seccomp/namespaces (Linux-only, unbuildable and untestable on this dev machine).
 *
 * `uid`/`gid` only do anything if the worker process itself has the privilege to
 * drop to them (e.g. running as root) — on an unprivileged worker they are a no-op
 * at best, an `EPERM` at worst. This is a real, honest limit of the mechanism, not
 * an oversight: `node:child_process`'s own `uid`/`gid` options carry the same limit,
 * this doesn't add a capability Node lacked, it just makes using it a policy choice
 * instead of a manual `execFile()` option a caller could forget to pass.
 */
export interface SandboxProfile {
  readonly env: Readonly<Record<string, string>>;
  readonly uid?: number;
  readonly gid?: number;
}

/**
 * No profile supplied — `PATH` only, never full inheritance from `process.env`. The
 * honest minimum a spawned binary needs to be found at all; a real deployment that
 * needs more (an LLM provider's API key, for instance) must declare it explicitly in
 * its own `SandboxProfile.env`, not rely on ambient inheritance from the worker's
 * own environment carrying more than the adapter actually needs.
 */
export function minimalSandboxProfile(): SandboxProfile {
  const path = process.env.PATH;
  return { env: path !== undefined ? { PATH: path } : {} };
}

export interface ScopedExecOptions {
  readonly cwd?: string;
  readonly maxBuffer: number;
  readonly env: Readonly<Record<string, string>>;
  readonly uid?: number;
  readonly gid?: number;
  /**
   * Bounded execution: `node:child_process`'s own `timeout` — after this many ms it
   * sends `killSignal` to the spawned child (and, on POSIX, its process group), so a
   * hung engine cannot block an assessment forever. Only the process THIS call
   * launched is affected; nothing else is touched. Omitted = no timeout (previous
   * behavior).
   */
  readonly timeout?: number;
  readonly killSignal?: NodeJS.Signals;
}

/**
 * Pure — the exact options every adapter's `defaultExec()` passes to
 * `node:child_process`'s `execFile()`. Given no `sandbox`, defaults to
 * `minimalSandboxProfile()` rather than falling through to `execFile()`'s own
 * default (inherit the calling process's full `env`) — the default itself is scoped,
 * not just the opt-in case, since an adapter author who forgets to pass a profile
 * should get the safe behavior, not the unscoped one.
 */
export function scopedExecOptions(
  cwd: string | undefined,
  sandbox: SandboxProfile | undefined,
  maxBuffer = 64 * 1024 * 1024,
  timeoutMs?: number,
): ScopedExecOptions {
  const profile = sandbox ?? minimalSandboxProfile();
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    maxBuffer,
    env: profile.env,
    ...(profile.uid !== undefined ? { uid: profile.uid } : {}),
    ...(profile.gid !== undefined ? { gid: profile.gid } : {}),
    ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGKILL' as NodeJS.Signals } : {}),
  };
}
