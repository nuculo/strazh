# M0 — Live Promptfoo → RTAP proof

This directory holds the **M0 milestone** live proof: evidence that RTAP's real
production promptfoo path can drive a **live** promptfoo process against a **local**
Ollama model and commit a **real** Observation to SQLite — with no fixture and no
injected fake anywhere in the path.

This is a **local reproduction harness, not production code and not part of the
build or the hermetic test suite** (`tsconfig.json` includes only `src`; vitest only
collects `*.test.ts`). It exists so the live path can be re-run on demand.

## What it proves

```
one local RunStep
  → real PromptfooCliAdapter (default execFile, no fake execFn/readFileFn)
  → live `promptfoo redteam run` (pinned promptfoo 0.122.0)
  → local Ollama model (qwen2.5:0.5b, localhost:11434 only)
  → promptfoo --output JSON file (real, not a fixture)
  → RTAP normalization (parse → verdict → evidence materialization)
  → committed Observation + CampaignEvent in SQLite
  → SUCCEEDED RunStep, COMPLETED ExecutionAttempt
```

The single probe is a harmless prompt-injection / system-prompt-leak intent. Both
attack generation and grading are **configured** to run on the **local** model
(`redteam.provider: ollama:chat:qwen2.5:0.5b`) with
`PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION=true` and telemetry/update/sharing
disabled, so no external or paid provider is configured or intended.

Network-evidence caveat: this is provider *configuration* plus disabled telemetry —
it is strong evidence of intent, but it is **not** proof that zero other outbound
connections occurred. We did not run a packet capture, and we made no system-wide
firewall change (that would need administrator access and is out of scope). If you
need a hard guarantee, capture traffic or apply an egress policy at your own network
boundary. The provider config and the captured target response do confirm the
attack traffic itself went to `http://localhost:11434`.

## Prerequisites (one-time, local only)

1. **Ollama** installed and running, with the model pulled:
   ```
   ollama pull qwen2.5:0.5b
   ```
   (`ollama serve` must be listening on `localhost:11434`.)

2. **Pinned promptfoo 0.122.0** in an isolated runtime directory (kept OUT of RTAP's
   own dependencies on purpose). The pin is committed as
   `m0/promptfoo-runtime/{package.json,package-lock.json}`; restore it with `npm ci`
   (this writes `node_modules/`, which is git-ignored, never committed):
   ```
   cd m0/promptfoo-runtime
   npm ci        # reproducible install from the committed lockfile
   ```
   The entrypoint is then at
   `m0/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js`.

   Note on "matching the vendored source": the repo's vendored `promptfoo/` tree was
   added in a single import commit labelled 0.122.0, and the published
   `promptfoo@0.122.0` shares the same version string — but a matching version string
   and a one-commit vendor import do **not** by themselves prove the published npm
   package is byte-for-byte identical to the vendored source (the vendor tree could
   carry local edits, and npm publishes a built `dist/` we did not diff file-by-file).
   Treat the published pin as "the same released version", not as proven-identical to
   the vendored tree.

## Run

From `rtap/` (PowerShell):

```powershell
$env:M0_PROMPTFOO_BIN = "<abs path>/_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js"
$env:M0_DB            = "<abs path>/m0-proof.sqlite"
$env:OLLAMA_BASE_URL  = "http://localhost:11434"
npx tsx m0/run-live-proof.ts
```

Expected: outcome `COMMITTED`, one Observation, RunStep `SUCCEEDED`, ExecutionAttempt
`COMPLETED`, an evidence ref of the form `local:sha256:<64 hex>`, and `0` quarantine
rows.

## Files

- `redteam.local.yaml` — the smallest local promptfoo redteam config: one `intent`
  plugin (exactly one test case, `numTests` is ignored for `intent`), no strategies,
  target + grader both the local Ollama model.
- `run-live-proof.ts` — the harness. Builds the real RTAP stores and drives the real
  `runPromptfooWorkerOnce()` with a **default** `PromptfooCliAdapter`.
- `promptfoo-output.json` — the last real promptfoo `--output` file (regenerated each
  run; git-ignored).

## Production code touched for M0

Two minimal, cross-platform-safe changes in `src/adapters/promptfoo/run.ts`, both
exercised by the live run and protected by hermetic unit tests in
`test/promptfoo-adapter.test.ts`:

1. `defaultExec()` launches a JavaScript entrypoint **shell-free**: when `binPath`
   ends in `.js`/`.cjs`/`.mjs` it spawns `process.execPath` (Node) with the
   entrypoint as its own argv element, so there is no shell and no command-line
   re-parsing — spaces and shell metacharacters in the path/args are inert. This is
   why `M0_PROMPTFOO_BIN` points at `.../promptfoo/dist/src/main.js`, not the npm
   `.cmd`/POSIX shim (Node's `execFile` refuses to spawn a `.cmd` directly since
   CVE-2024-27980). A plain native executable still spawns unchanged.
2. `run()` accepts promptfoo's real `--output` envelope, whose `results` is the
   `EvaluateSummaryV3` object with the per-case array nested at `results.results[]`,
   in addition to the older flat `{results: [...]}` shape.

Both are covered by hermetic tests in `test/promptfoo-adapter.test.ts` (the launch
test spawns a stand-in `.js` entrypoint from a directory whose path contains spaces
and special characters; the envelope tests cover both nested and flat shapes).
