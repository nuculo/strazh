# RTAP — RedTeam Assessment Platform

> **Product Quick Links:** For main product overview, assessment commands, dashboard setup, and project domains, see the root [README.md](../README.md).

### Project Domains
The owner confirms the following domains have been purchased for this project:
- **`strazh.dev`**
- **`kupol.app`**

*Status:* Roles are undecided. DNS, hosting, and deployment status has not been verified. No DNS, hosting, or branding changes have been made in this repository.

### Quick Start (Runnable Workflows)
- **Nebius × NVIDIA Hackathon Demo:**
  - Demo Server: `npm run demo` (or offline `npm run demo:offline`)
  - Live Assessments: `npm run assess:demo:live:baseline` and `npm run assess:demo:live:mitigated`
  - Offline Assessments: `npm run assess:demo:baseline`, `npm run assess:demo:mitigated`, `npm run assess:demo:unavailable`
  - Demo Runbook: [../docs/demo_runbook.md](../docs/demo_runbook.md)
  - Devpost Draft: [../docs/hackathon_submission_prep.md](../docs/hackathon_submission_prep.md)
- **Local & Static Results Dashboard (Replay Mode):** `npm run dashboard` from `rtap/`, then open [http://127.0.0.1:3000/dashboard/index.html](http://127.0.0.1:3000/dashboard/index.html). The dashboard is also deployable to any static host (e.g. GitHub Pages) directly from `rtap/dashboard/` as a self-contained, zero-inference, zero-credential replay viewer.
- **Out-of-Band Artifact Isolation:** Public sample reports in `demo/out/` and `m1/out/` contain cryptographic SHA-256 hashes (`artifact:sha256:...`) referencing out-of-band evidence. These hash references do not grant access to private underlying artifact payloads.
- **M1 Assessment CLI (Windows PowerShell one-line):**
  - *Via workspace `_tooling`:* `npm run assess -- --target=m1/target.example.yaml --out-dir=m1/out --promptfoo-entry=../../_tooling/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js`
  - *Via portable in-repo runtime:* `npm --prefix m0/promptfoo-runtime ci; npm run assess -- --target=m1/target.example.yaml --out-dir=m1/out --promptfoo-entry=m0/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js`
  - Details: see [m1/README.md](m1/README.md)
- **Reconciliation Audit:** [../docs/reconciliation_report.md](../docs/reconciliation_report.md) (evaluating GitLab/Rust claims)

---

Control Plane skeleton, Phase 0 through Phase R (Duo LLM remediation), plus Phases

4.5.1–4.5.4 (the complete Execution Safety & Recovery gate: identity/fencing,
effect journal/recovery, authorization/scheduling, and interceptors/operations),
plus three audit-driven fixes: candidate identity is `(targetId, probeId)` end to
end ("Bug fix: target-scoped binding and dispatch dedup"); schema changes go
through a real, transactional, tracked migration registry instead of a
`CREATE TABLE IF NOT EXISTS` no-op ("Bug fix: schema migrations"); and
`commitFencedObservation()` is the sole canonical commit path, with the fencing
check, the Observation/CampaignEvent insert, and terminalizing the attempt all in
one transaction ("Bug fix: fenced commit is the sole canonical API"). All twelve
of the Execution Safety & Recovery gate's Architecture Laws hold; §15 admission
itself is honestly not yet met — see the Phase 4.5.4 section's admission suite.
Source
of truth for shapes and invariants is
[wiki/Arch_Overlay/ARCHITECTURE.md](../wiki/Arch_Overlay/ARCHITECTURE.md),
[wiki/Arch_Overlay/FROZEN_INTEGRATION.md](../wiki/Arch_Overlay/FROZEN_INTEGRATION.md),
[wiki/Arch_Overlay/ADAPTIVE_REDTEAM_RUNTIME.md](../wiki/Arch_Overlay/ADAPTIVE_REDTEAM_RUNTIME.md)
and [wiki/Arch_Overlay/FROZEN_META_HARNESS.md](../wiki/Arch_Overlay/FROZEN_META_HARNESS.md) —
this package makes those documents' contracts and laws executable, it does not
redefine them. If code and docs disagree, that is a bug in one of them, not a
license to pick either silently.

## What's here (Phase 0 — F0)

- `schemas/*.schema.json` — JSON Schema (2020-12) for every wire object named in
  ARCHITECTURE.md §1 Ubiquitous Language and FROZEN_INTEGRATION.md §2-§9: Target,
  Probe, Observation, Finding, CampaignEventEnvelope, FeatureSnapshot/V60,
  FrozenSignal, SignedModelArtifact, RecommendationBinding.
- `src/laws/` — the Architecture Law Registry: stable IDs, statements, seeded
  deterministic trials, replay. Ported as a *pattern* from
  `frozen/crates/frozen-core/src/law.rs`, not as code.
- `src/domain/` — the small amount of pure business logic Phase 0 laws need to have
  something real to check: verdict derivation, the `RecommendationBinding`
  execution guard, model/adapter fit, native-metric namespacing.

## What's honestly not here yet

27 laws are registered — every ID named in ARCHITECTURE.md §8, FROZEN_INTEGRATION.md
§10, and (Phase 2) the two feature-view laws from ADAPTIVE_REDTEAM_RUNTIME.md
§4.4/§14. 14 are `status: 'implemented'` with real seeded property checks; 13 are
`status: 'pending'` with a stated reason and the phase that unblocks them (`npm run
laws` prints both). Do not fake the count — `frozen`'s own README explains why:
"счётчик роста меняется от каждого захода, не неся решения". A pending law here is
deliberately visible, not silently skipped.

Not attempted at all in Phase 0: the `FrozenService` Rust facade (§5.1, lives in
`frozen/`, not here), `Dataset::try_new()`/total `try_*` APIs (also `frozen/`),
threat model/license ADR, engine capability matrix.

## What's here (Phase 1 — promptfoo vertical slice)

ARCHITECTURE.md §9 Phase 1: "Control Plane + durable RunSteps; SQLite/filesystem
профиль; PromptfooAdapter; Observation/Finding/report pipeline; запись
CampaignEvents, frozen пока replay-only fixture."

- `src/db/connection.ts` — SQLite via Node's built-in `node:sqlite` (experimental,
  no native-binding dependency). Swap for the PostgreSQL production profile
  (Phase 7) behind the same store interfaces; nothing above this layer imports
  `node:sqlite` directly.
- `src/runsteps/` — the durable RunStep queue: `PENDING → LEASED → RUNNING →
  SUCCEEDED | FAILED | CANCELLED` (ARCHITECTURE.md §4), idempotent enqueue,
  lease/reclaim-on-expiry, owner-checked transitions.
- `src/events/store.ts` — the CampaignEvent log: append-only, schema-validated on
  write, monotonic sequence per campaign, idempotent on duplicate `eventId`.
  Nothing reads it back yet — that's Phase 4. Right now it is exactly what §9
  Phase 1 calls "frozen пока replay-only fixture": real, durable, unconsumed.
- `src/adapters/promptfoo/` — the Anti-Corruption Layer: `parse.ts` maps
  promptfoo's real `EvaluateResult`/`GradingResult` shape (verified against
  `promptfoo/src/types/index.ts`, not guessed) to an RTAP `Observation`, re-deriving
  the Verdict through Phase 0's `deriveVerdict()` rather than trusting promptfoo's
  own `pass`/`fail` directly. `run.ts` wraps `promptfoo redteam run` for real — see
  its doc comment for why this isn't exercised against a live promptfoo process in
  this test suite (needs real provider API keys), only against an injected exec
  function and a hand-verified fixture.
- `src/pipeline/` — `correlateFindings()` (groups Observations into Findings by
  `(targetId, probeId)`, documented verdict-aggregation precedence), JSON/Markdown
  report builders, and `eventForObservation()` (Observation → CampaignEvent
  mapping).
- `src/observations/`, `src/findings/` — SQLite-backed stores, schema-validated on
  write.
- `src/pipeline/commit-observation.ts` — commits an Observation and its
  CampaignEvent in one SQLite transaction; a CampaignEvent that fails validation
  rolls back the Observation insert too. No state where an Observation exists
  without a corresponding committed event.
- `test/integration/vertical-slice.test.ts` — the whole thing wired together
  end-to-end against a real in-memory SQLite database: enqueue a RunStep → lease →
  run the (fixture-backed) PromptfooAdapter → parse → atomically commit
  Observation+CampaignEvent → complete the RunStep → correlate Findings → build a
  report.

Phase 1 policy decisions made and documented inline, not silently: Finding
severity is a placeholder (`high`/`informational`) pending a real risk-scoring
model. See `../wiki/Arch_Overlay/ADAPTIVE_REDTEAM_RUNTIME.md` §5.1/§11 for two
gaps this slice does not yet close: it does not distinguish a grader-side error
from absent grading (both currently resolve to `UNVERIFIED`, which is safe but
under-specific — promptfoo's own error-vs-fail signal for a *grader* crash, as
opposed to a *provider* crash, isn't cleanly separable in its current output
shape); and `ObservationNormalizer` here is total with graceful defaults, not the
`Observation | NormalizationError` port that document specifies — a malformed
individual result degrades to a generic probeId rather than surfacing a
normalization failure.

## What's here (Phase 2 — offline dataset and baselines)

FROZEN_INTEGRATION.md §12 F2 / ADAPTIVE_REDTEAM_RUNTIME.md §15 P2.

- `src/features/` — closes a gap flagged after Phase 1: `rtap:feature-snapshot` now
  carries `featureView: OBSERVATION | CANDIDATE` (schema `if/then`, plus two new
  laws), and there are two real, distinct compilers. `observation-compiler.ts`
  describes evidence already obtained; `candidate-compiler.ts` describes a possible
  next RunStep and structurally cannot see an outcome — its parameter type has no
  field to carry one. `history-view.ts` reconstructs "world state strictly before
  event N" from already-committed CampaignEvents (real Phase 1 infrastructure), not
  the full Frozen CampaignWorld (that's Phase 4). Coordinates this repo has no real
  signal for yet (response text, latency/cost) are an explicit `MISSING` sentinel
  (`features/missing.ts`), never guessed.
- `src/training/` — `UtilityLabelPolicy` (versioned weights, not code, per
  FROZEN_INTEGRATION.md §8.1), `dataset-exporter.ts` (committed history →
  `TrainingExample[]`, with the documented exclusions), `splits.ts` (group-clean
  target/campaign/time/vulnerability-class holdouts — "random row split is
  forbidden", §8.2), `evaluate.ts` (MSE/MAE/Spearman rank correlation — Planner acts
  on rank, not absolute value), `admission-gate.ts` (beat-the-baseline check, honest
  about which baselines it didn't compare against).
- `src/training/baselines/`: `random` (deterministic per-candidate, not
  process-random — §16 admission criteria requires reproducible inference),
  `fixed-order` (a small hand-picked priority list, explicitly not sourced from
  promptfoo's real severity data — that would cross the ACL boundary), `heuristic`
  (fixed, hand-chosen weights over the campaign-history coordinates), and
  `linear-regression` (real batch gradient descent, pure TS — §8.3 names "logistic
  regression"; a continuous utility label makes plain linear the correct family
  member, documented substitution). Tree/boosting, a small MLP, and the actual
  frozen-kan comparison are **not implemented** here — `NOT_IMPLEMENTED_BASELINES`
  says so explicitly rather than the gate silently comparing against fewer models
  than the doc names.
- `src/training/model-artifact.ts` — wraps a fitted model in the same
  `SignedModelArtifact` envelope real frozen artifacts use, with a genuine SHA-256
  over the serialized weights. Honestly unsigned (`signature: 'UNSIGNED'`) — no
  signing authority exists yet (FROZEN_INTEGRATION.md §13 open decision), so this
  artifact is not fabricating a credential it doesn't have.

**A real finding from building this, not a hypothetical one:** the first version of
`compileCandidateFeatures`/`compileObservationFeatures` encoded "strategy" as
`probeId.includes(':') ? 1 : 0` — every real `probeId` has that shape, so the
coordinate was a silent constant carrying zero information, and the integration
test's admission-gate assertion had been quietly softened to `typeof(...) ===
'boolean'` rather than checking a real outcome. Fixed the encoding (distinct
`hashBucket` coordinates for class, strategy, and the (class, strategy) pair) and
re-diagnosed empirically rather than guessing: on the synthetic corpus, the linear
baseline still loses to `heuristic` on rank correlation (~0.04 vs ~0.26, stable
across L2 regularization from 0.01 to 1.0 — not an overfitting artifact) once the
bug was fixed. `test/integration/offline-training-slice.test.ts` now asserts that
outcome directly and explains why: 60 hash-bucket-encoded coordinates over ~70
training rows is a genuinely underdetermined linear problem, and this is exactly
the case ADAPTIVE_REDTEAM_RUNTIME.md §16's stop condition ("model does not beat
deterministic heuristic") exists to catch. The admission gate correctly says no —
that is the mechanism working, not the pipeline failing.

## What's here (Phase 3 — shadow candidate scoring)

FROZEN_INTEGRATION.md §12 F3 / ADAPTIVE_REDTEAM_RUNTIME.md §15 P3 / §9.1 "Frozen v0"
shadow-first lifecycle / FROZEN_META_HARNESS.md §10 operating lifecycle.

- `src/promotion/` — the `OFF → SHADOW → EXPERIMENTAL → CALIBRATED` state machine,
  taken verbatim from the documented diagram (three independent docs now describe
  this graph; this is one literal encoding of it, not a reinterpretation). Illegal
  transitions are rejected and logged, never coerced — "the model cannot promote
  itself" is enforced by `applyEvent` refusing any event the current state doesn't
  declare, not by trusting the caller's intent. `ModelPromotionRegistry` is
  SQLite-backed: `model_promotions` (current state per `modelRef`) and
  `model_promotion_log` (every attempted transition, allowed or not).
- `src/candidates/` — `enumerateEligibleCandidates()`: mandatory probes always
  eligible; everything else filtered by attempts-so-far and confirmed-vulnerable
  exclusion, both against the same `CampaignHistoryView` Phase 2 already builds. Pure
  function, no I/O — enumeration cannot itself influence execution.
- `src/shadow/`:
  - `signal.ts` — `scoreCandidate()` produces a schema-valid `FrozenSignal{kind:
    PROBE_UTILITY}`. `quality` is always the caller-declared promotion state's own
    quality; a SHADOW-registry model cannot claim an EXPERIMENTAL/CALIBRATED signal.
  - `rank.ts` — `rankCandidates()` never throws:
    `redteam.planner/frozen-failure-falls-back-to-heuristic` is real here — if the
    primary model throws on any candidate, the *entire batch* falls back to the
    heuristic baseline (never a mix of model-scored and heuristic-scored candidates
    in one ranking).
  - `store.ts` — persists rankings to `shadow_rankings`. Never touches
    `RunStepStore` — checked empirically by
    `redteam.frozen/meta-harness-does-not-create-runstep` (row-count-unchanged
    property test), not just by the absence of an import.
  - `counterfactual.ts` — ADAPTIVE_REDTEAM_RUNTIME.md §9.1's comparison record:
    model rank, heuristic rank, random rank and the actual verified outcome, joined
    for one historical decision. Ranking is computed the same way online scoring
    would be — the actual choice is added to the candidate set only to find where it
    *landed*, never fed back into what produced the ranking.
- `test/integration/shadow-scoring-slice.test.ts` — a Phase 2-trained model admitted
  (`OFF`) → promoted (`SHADOW`) → ranks real eligible candidates → persisted, with an
  explicit before/after `RunStepStore` row-count assertion; plus counterfactual
  records built over ten real historical decisions from the synthetic corpus.

Two new laws (29 total, 16 implemented): `redteam.planner/frozen-failure-falls-back-
to-heuristic` and `redteam.frozen/meta-harness-does-not-create-runstep` — the second
one's ID borrows FROZEN_META_HARNESS.md §11's wording directly since that document
names this exact invariant most precisely; see the law-ID drift note below.

**Known, unresolved from earlier phases, still true:** the same concept now has
independently-worded IDs across four documents (e.g. `redteam.signal/frozen-signal-
is-not-a-verdict` vs `redteam.frozen/signal-is-not-a-verdict` vs
`meta-harness-signal-is-not-a-verdict`). Not resolved here — still needs a human
decision on which ID string is canonical before these laws get consumed outside this
repo.

## What's here (Phase 4 — event-sourced CampaignWorld)

FROZEN_INTEGRATION.md §12 F4 / ADAPTIVE_REDTEAM_RUNTIME.md §15 P4.

- `src/world/graph-schema.ts` — the immutable entity/relation vocabulary from
  FROZEN_INTEGRATION.md §3.1 (`Target`, `ProbeClass`, `Strategy`, `Finding`,
  `SecurityControl`, `Domain`, `ModelVersion` × 7 relation types), with
  `isLegalRelation()` rejecting anything not declared — checked before merge, not
  after. Only `Target`/`ProbeClass`/`Finding` and the two relations connecting them
  are actually derived from events today, because that's what this repo's own event
  payload shape (`{targetId, probeId, verdict}`) carries; the rest of the vocabulary
  is declared platform-wide but has no producer yet. Documented gap, not a silent one.
- `src/world/reducer.ts` — `applyEvent()`: idempotent on a repeated `eventId` (same
  world reference back, not just equal), rejects a sequence gap outright (`ok:
  false`, world untouched), advances epoch by exactly 1 on every accepted event.
- `src/world/replay.ts` — rebuilds a world from `emptyWorld()` by applying a
  campaign's events in sequence order; stops (does not skip) at the first gap, per
  FROZEN_INTEGRATION.md §6.
- `src/world/fingerprint.ts` — real SHA-256 over a canonicalized (sorted) view of
  the world, independent of `generation` — content identity and lineage are
  deliberately separate concepts (`worldGeneration` from Phase 0's
  `RecommendationBinding` work).
- `src/world/binding.ts` — `worldPositionOf()` is the first real producer of the
  `WorldPosition` shape Phase 3's shadow scoring needed; replaces the
  `{worldGeneration: 0, worldEpoch: allEvents.length}` placeholder the Phase 3 tests
  used before this module existed.
- Closed four laws that were pending specifically for this phase (29 total now
  20 implemented, was 16): `redteam.frozen/replaying-the-same-events-produces-the-
  same-fingerprint`, `redteam.frozen/duplicate-event-is-idempotent`,
  `redteam.frozen/event-gap-is-rejected`, `redteam.replay/same-events-produce-same-
  state`. Left `redteam.frozen/state-change-advances-epoch` pending on purpose — its
  statement is specifically about `frozen-runtime::DynamicState` (Rust), a different
  aggregate than RTAP's own `CampaignWorldState`; the pendingReason now says so
  explicitly rather than let the two get confused.
- `test/integration/event-sourced-world-slice.test.ts` — real Phase 1 committed
  events (same synthetic-corpus fixture Phase 2/3 use) replayed into a world,
  fingerprint-stable across two independent replays and across generations, feeding
  a real `WorldPosition` into Phase 3's `rankCandidates`, and a genuine dropped-event
  gap stopping replay cleanly rather than silently producing a wrong world.

**Still not attempted**: episodic memory rings, per-entity V60 state, snapshots
(§7 — deferred "until measuring replay cost" per the doc itself), and any of this
feeding into a real `frozen-runtime` Rust process — this is RTAP's own canonical
event store and reducer, not frozen's internal `DynamicState`. FROZEN_META_HARNESS.md
§8's "RTAP owns canonical events, Frozen owns derived runtime state" framing is
exactly the boundary this phase stayed on the RTAP side of.

## What's here (Phase 5 — experimental planner)

FROZEN_INTEGRATION.md §12 F5 / ADAPTIVE_REDTEAM_RUNTIME.md §15 P5 / §10 Guarded
planner.

- `src/planner/policy.ts` — `PlannerPolicy` (versioned, same discipline as
  `UtilityLabelPolicy`). `validatePolicy()` refuses `explorationShare <= 0` outright
  — the exploration arm cannot be configured away, not just "usually" reserved.
- `src/planner/mixer.ts` — `mixCandidates()`, the first place in this repo that
  actually spends Phase 0's `decideExecution()` for real. Fixed order of operations:
  mandatory seats first (unconditionally), then exploration reserves its share of
  what's left *before* the model gets to claim anything, then the model arm claims
  up to `modelShareCap` — filtered through `decideExecution` against the live
  `RecommendationBinding`, so a stale recommendation falls through to heuristic
  instead of becoming a RunStep — then heuristic fills the remainder. Every slice is
  bounded by construction; a post-hoc trim is never needed. When mandatory alone
  exceeds the batch cap, the shortfall is reported (`mandatoryShortfall`), never
  silently dropped and never silently pushed over budget.
- `src/planner/dispatch.ts` — `dispatchDecisions()` is the *only* function in this
  repo that turns a Planner decision into a durable RunStep. The mixer itself never
  calls it — deciding and dispatching are separate steps on purpose, so a caller can
  inspect a `MixResult` first. This is the concrete behavioral line between Phase 3
  (SHADOW: ranks and logs, `RunStepStore` never moves) and Phase 5 (EXPERIMENTAL:
  the same kind of ranking now actually enqueues work).
- `src/planner/ab.ts` — joins the dispatch log's arm attribution with real verified
  outcomes (Phase 2's label, keyed by `probeId`) and computes `PROMOTE`/`HOLD`/
  `DEMOTE` against the `heuristic` arm specifically (the deterministic control, not
  the deliberately-noisy exploration arm). `HOLD`s on thin samples rather than
  promoting or demoting on weak evidence — "the model cannot promote itself"
  extends to "the gate does not act on thin evidence either."
- Closed the four planner laws that were pending for this phase (29 total, 24
  implemented, was 20): `mandatory-probes-cannot-be-ranked-away`,
  `exploration-arm-never-disappears`, `control-arm-never-disappears`,
  `budget-is-never-exceeded`.
- `test/integration/experimental-planner-slice.test.ts` — a Phase 3-trained,
  Phase 3-promoted (OFF→SHADOW→EXPERIMENTAL) model mixed against a real Phase 4
  world binding, dispatched to real RunSteps (explicit before/after count showing
  `RunStepStore` actually moved, unlike Phase 3), plus two scenarios feeding
  simulated A/B outcomes through the gate into a real `EXPERIMENTAL → CALIBRATED`
  promotion and a real `EXPERIMENTAL → SHADOW` demotion.

**A real finding from building this, not staged:** two of the first-draft unit
tests failed on first run — not because the mixer was wrong, but because the test
*inputs* were self-defeating. One assumed a stale model recommendation would always
reach the model-selection step, without accounting for the exploration arm's random
draw (which runs first, by design) occasionally consuming that exact candidate
first — nothing to fix in the mixer, the test needed a pool/share large enough to
make that collision negligible, documented as such. The other built a Planner
catalog directly from the same historical corpus used for training, which — under
the *default* eligibility policy (max 1 attempt) — left every non-mandatory probe
already exhausted, so there was nothing left for exploration to pick; fixed by
using a permissive policy for that integration test and noting that a real
catalog would come from the platform's full probe taxonomy, not from already-
consumed training data. Both are documented inline rather than quietly patched.

## What's here (Phase 6 — duo static fusion and domain adapters)

FROZEN_INTEGRATION.md §12 F6.

- `src/adapters/duo-static/` — the second real Anti-Corruption Layer in this repo,
  grounded the same way `promptfoo/` was: `Finding`/`ScanResult`/`ScanSummary`
  field names verified against `duo-agents/src/scan/mod.rs`, and the test fixture
  (`test/fixtures/duo-static-scan-result.json`) is *extracted from a real captured
  scan* (`duo-agents/gitlabhq_scan.json`, a real 1684-finding scan of gitlabhq
  18.6.2), not hand-written. `parse.ts` maps every finding to `verdict: UNVERIFIED`
  unconditionally — not a simplification, a direct consequence of
  `wiki/Arch_duo-agents/ARCHITECTURE.md` documenting the scan plugins as line-regex
  substring matching (no AST, no taint analysis despite README claims) with a
  routing bug that makes even *absence* of a finding unreliable evidence of safety.
  Native severity survives as a `duo`-namespaced `NativeMetric` rather than being
  discarded. `run.ts` invokes the real command shape
  (`duo-agents scan --path <path> --format json`) — not the `scan-json` shell alias
  and not the positional-arg form GitLab CI docs recommend, which
  `wiki/Arch_duo-agents/ARCHITECTURE.md` confirms actually fails with exit code 2.
  It also surfaces a second real, confirmed bug: `summary.total_findings` is
  computed from the pre-`--min-severity`-filter set and disagrees with the emitted
  `findings` array (verified: 9159 vs 1684 on the real scan) — `run.ts` reports
  `summaryMismatch` explicitly rather than trusting `summary` for counts.
- No duo-specific branch was needed in `world/reducer.ts` — duo-static Observations
  commit through the exact same `{targetId, probeId, verdict}` event shape
  promptfoo Observations do (`TargetKind: REPOSITORY`, already declared in Phase 0's
  schema, unused until now), and replay into the same `CampaignWorld` unmodified.
  Verified directly in the integration test.
- `src/domain-adapters/matrix.ts` — `evaluateAdapterAdmission()` implements
  FROZEN_INTEGRATION.md §8.4's diagonal cross-domain matrix exactly: admits only
  when own-domain gain clears a threshold *and* every off-domain gain stays at or
  below it; rejects a "free adapter" (positive gain everywhere) even with a strong
  own-domain result, and rejects on missing evidence rather than assuming success.
- `src/domain-adapters/metadata.ts` / `swap.ts` / `registry.ts` — `reassignEvery > 0`
  (frozen's own calibration parameter, per FROZEN_REDTEAM_HLD.md §10.1) is rejected
  regardless of admission strength; mid-run swap is unconditionally rejected (no
  state-invariance laws exist to permit it, an honest scope limit, not a
  workaround); `DomainAdapterRegistry.swap()` is the *only* method that mutates
  active-adapter state, enforcing all three rules together so nothing can bypass
  one by calling something lower-level. `rollback()` reverts to the previous
  active adapter, including the implicit "no adapter" start state after exactly
  one swap — found and fixed during testing, see below.
- Two new laws (31 total, 26 implemented, was 24): `redteam.frozen/domain-adapter-
  requires-diagonal-gain` and `redteam.frozen/overlay-adapter-forbids-reassignment`
  — derived from §8.4's prose directly, since no prior document in this repo named
  an ID for either.
- `test/integration/duo-static-and-domain-adapter-slice.test.ts` — real scan
  fixture through commit → replay → world, plus adapter admission → swap →
  rollback and a rejected mid-run swap.

**A real finding from building this, not staged:** the first version of
`DomainAdapterRegistry.rollback()` required two prior allowed swaps to have
anything to revert to, so a domain with exactly one swap (its very first adapter
being replaced) couldn't roll back at all — even though "no adapter was active
before this one" is a real, valid rollback target, just not one that had been
explicitly logged as its own history entry. Fixed by treating a single prior swap's
implicit start state (`null`) as a legitimate rollback target; only a domain with
*zero* swaps has genuinely nothing to revert to. The test that exposed this is now
`test/domain-adapters/registry.test.ts`'s "reverts to the implicit 'no adapter'
start state" case, replacing what had been an assertion of the old (wrong) behavior.

## What's here (Phase 7 — production profile)

ARCHITECTURE.md §9's Phase 7 bullet: "PostgreSQL/S3/KMS, RBAC, tenancy, audit;
snapshots/replay recovery; UI/MCP/GitLab delivery." This phase reads as three ports
ARCHITECTURE.md §3.4 has named since Phase 0 and nothing had ever implemented —
`ArtifactStore`, `SecretProvider`, `AuthorizationProvider` — plus audit and
snapshots. Each local-profile piece below is real and fully tested; each
production-profile piece (PostgreSQL, S3, KMS/Vault, UI/MCP/GitLab) is a stated,
structural gap rather than an untested stand-in — see "What's honestly not here"
below for why, per bullet.

- `src/artifacts/` — `ArtifactStore` port plus `FilesystemArtifactStore`, the local
  profile. Content-addressed: `ref` is always `local:sha256:<hex-of-the-body>`, so
  identical bytes dedup to the same ref and a ref can never be forged into pointing
  at unrelated content — `get()`/`exists()` re-validate the ref pattern before
  touching the filesystem, which also rules out path traversal by construction (a
  hex digest cannot contain `/` or `..`). This is the first real implementation of
  the "Protected Artifact Store" ADAPTIVE_REDTEAM_RUNTIME.md has drawn in its runtime
  diagram since Phase 0 — every adapter until now has produced a synthetic string
  `EvidenceRef` (`promptfoo:${runId}:${resultId}`) with nothing behind it.
- `src/secrets/` — `SecretProvider` port plus `EnvSecretProvider`, resolving the
  `env:` scheme against `process.env`. Scheme-prefixed by design
  (`"<scheme>:<locator>"`) so KMS/Vault can be added later as another scheme, not a
  replacement — an unsupported scheme (`vault:...`, `kms:...`) is rejected loudly,
  not silently ignored. First real resolver for `Target.secretRef`
  (`rtap:common#/$defs/SecretRef`), declared in schemas since Phase 0 and never
  resolved to an actual value until now.
- `src/authz/` — `AuthorizationProvider` port plus `RoleBasedAuthorizationProvider`:
  three roles (VIEWER/OPERATOR/ADMIN, additive), nine named actions. Tenancy is
  checked *before* role and is unconditional — a cross-tenant request is denied even
  for ADMIN, because tenant isolation is a boundary, not a permission a role grants
  out of. Scoped deliberately: this is the RBAC/tenancy boundary itself, not a
  retrofit of `tenantId` columns across the eight pre-existing SQLite stores (see gap
  below).
- `src/audit/` — `AuditLog`, an append-only SQLite table (`audit_log`), and
  `AuditingAuthorizationProvider`, a decorator that wraps any `AuthorizationProvider`
  and records every decision — allowed *and* denied — before returning it. Ties
  "RBAC, tenancy, audit" together as one path: nothing can call `authorize()`
  through the wrapper and have the decision go unaudited.
- `src/world/snapshot.ts` — `snapshotWorld()`/`verifySnapshot()`, exactly
  FROZEN_INTEGRATION.md §7's field list (campaign/world ID, last event sequence,
  world fingerprint, epoch, ModelSnapshot ref and WorldBinding, cryptographic
  digest, format version), with a SHA-256 digest over the canonical body. Explicitly
  does **not** carry entities/relations and does not let a caller skip `replay()` —
  the doc itself is explicit that a snapshot "never replaces canonical event history
  until retention and audit policy explicitly allows compaction," and that policy
  decision hasn't been made. What it gives instead: `restorePosition()` for cheap,
  replay-free access to generation/epoch/lastSequence/fingerprint, and
  `verifySnapshot()` to confirm a fully-replayed world matches what was snapshotted
  (or to catch a tampered/corrupted snapshot record on its own, with no world to
  compare against).
- Four new laws (35 total, 30 implemented, was 26): `redteam.artifact/store-is-
  content-addressed`, `redteam.authz/cross-tenant-access-is-always-denied`,
  `redteam.audit/every-decision-is-recorded`, `redteam.world/snapshot-digest-
  detects-tampering` — no prior document names IDs for any of these, derived from
  §3.4/§9 directly, same as the Phase 6 domain-adapter laws were from §8.4.
- `test/integration/production-profile-slice.test.ts` — one OPERATOR dispatches a
  run step (authorized, audited), resolves a target credential, stores real evidence,
  commits+replays a CampaignEvent through the unmodified Phase 4 path, and takes a
  verified snapshot of the result; the same OPERATOR is then denied `model:promote`
  and a different tenant's ADMIN is denied read access to this tenant's campaign —
  both denials land in the audit trail alongside the earlier grant.

**What's honestly not here**, and why, bullet by bullet against the Phase 7 line:

- **PostgreSQL.** Every store in this repo (`RunStepStore`, `CampaignEventStore`,
  `ObservationStore`, ...) is written against `node:sqlite`'s synchronous
  prepared-statement API (`.prepare(sql).run/.get/.all`), injected via constructor —
  see the updated comment in `src/db/connection.ts`. `pg`'s client is inherently
  async; there is no sync Postgres driver for Node. Bridging the two honestly means
  either a driver that doesn't exist or an async rewrite of every store, every
  pipeline function, and every test in this repo — a materially larger, different
  change than "add a production backend," not attempted here. The constructor-
  injection seam that already exists is where it would attach.
- **S3, KMS/Vault.** `ArtifactStore`/`SecretProvider` are designed so a real
  `S3ArtifactStore`/`VaultSecretProvider`/`KmsSecretProvider` is a same-shaped,
  scheme- or class-dispatched addition — not built here, because there is no live
  bucket, KMS endpoint, or Vault instance in this environment to test a real client
  against. A mocked one would be untested code wearing a real-looking name, which is
  exactly what the local-profile implementations were built to avoid being.
- **Tenancy across existing stores.** `tenantId` was not retrofitted into the eight
  pre-existing SQLite tables (`run_steps`, `campaign_events`, `observations`, ...).
  Tenancy enforcement lives at the `AuthorizationProvider` boundary built this phase,
  which is where a real system gates access regardless of how the rows underneath
  are or aren't partitioned — extending it into every existing table is a separate,
  larger migration.
- **UI/MCP/GitLab delivery.** No UI framework was chosen, no MCP server was built, no
  GitLab integration was written. These are delivery surfaces — a different kind of
  deliverable (frontend/integration code, with product and design decisions nobody
  has made) from everything else in this repo, which is backend domain logic and its
  tests. Left as a genuinely separate piece of future work, not attempted.
- **Snapshot-based replay-skip/compaction.** Deferred by the same doc that specifies
  the snapshot shape (FROZEN_INTEGRATION.md §7, quoted above) — building it anyway
  would mean inventing a retention/compaction policy nobody has decided on.

## What's here (Phase R — Duo LLM remediation)

ARCHITECTURE.md §9's Phase R bullet: "real TargetProvider; strategies/domains
connected; mandatory grader or explicit UNVERIFIED; deterministic scoring and
versioned DTO; only then enable DuoLlmAdapter." Before writing any code, this phase
investigated whether `duo-agents`' LLM redteam harness (distinct from the static
scanner integrated in Phase 6) actually meets any of these four gates. It meets
none of them, and fixing that is Rust-side work in `duo-agents`, out of scope for
this TypeScript Control Plane — so the honest deliverable is a real, grounded ACL
that keeps `DuoLlmAdapter` quarantined *in code*, not just in a doc's prose, plus
the capability-rejection mechanism ARCHITECTURE.md §3.4/§9 had described since
Phase 0 and nothing had implemented yet.

- **What was actually verified** in `duo-agents/src/redteam/` (full citations in
  `src/adapters/duo-llm/types.ts`'s doc comment): there is no `TargetProvider` —
  `response` comes from `simulate_ai_response()`, a private four-branch
  keyword-matched stub, never a real model call; `strategy_id` is `null` on every
  attack regardless of the `--strategies`/`--domains` flags passed
  (`RedteamConfig.strategies`/`.domains` are read from the CLI and then never read
  again — confirmed independently, not only against the pre-existing
  `wiki/Arch_duo-agents/REDTEAM.md` audit that reaches the same conclusion); only 4
  of 18 attack plugins have a real grader, and the other 14 (including five
  Critical-severity families: `ssrf`, `shell-injection`, `sql-injection`,
  `pii-leak`, `harmful-content`) get an automatic `pass: true, score: 1.0` via the
  literal fallback string `"No grader found, defaulting to pass"`; and
  `PluginRiskScore.worst_strategy` is a provably non-deterministic `HashMap` +
  `max_by` tie-break, with no version field anywhere in the DTO.
- `test/fixtures/duo-llm-redteam-report.json` — a **real** captured report, produced
  by actually building and running `duo-agents redteam --format json -o ...`
  (`duo-agents/target/release/duo-agents`), not hand-written — same discipline as
  Phase 6's real gitlabhq scan. Independently reproduces the wiki's central finding:
  every one of its `strategy_id` fields is `null` despite `--strategies`/`--domains`
  having been passed on the actual invocation that produced it. It also contains one
  genuinely graded failure (a reasoning-DoS hit), used to prove the quarantine holds
  even for a real detected issue, not only for the 28 ungraded results in the same
  capture.
- `src/adapters/capability.ts` — `EngineAdapterCapabilities`/`checkCapabilities()`,
  the generic mechanism ARCHITECTURE.md §3.4 implied but nothing built: any
  EngineAdapter can declare capabilities and have them checked *before* dispatch.
  Finally implements `redteam.adapter/unsupported-capability-is-rejected` (pending
  since Phase 0 for lack of a capability matrix to check against) — the law now
  proves, using the real `DuoLlmCliAdapter`, that rejection happens before `execFn`
  is ever invoked, not as an exec failure discovered afterward.
- `src/adapters/duo-llm/` — `types.ts` (DTOs grounded against
  `duo-agents/src/redteam/mod.rs` and `scoring.rs`), `parse.ts`
  (`parseDuoLlmRedteamReport()`: verdict always `UNVERIFIED`, `configIgnored: true`
  unconditionally since strategy/domain config is ignored for *every* attack, not
  only some; `graderKind: 'defaulted-pass'` for the sentinel-fallback results with no
  score metric emitted, `'deterministic-verifier'` for the 4 real graders with their
  score preserved as a `duo`-namespaced NativeMetric), and `run.ts`
  (`DuoLlmCliAdapter`, with `DECLARED_CAPABILITIES` set to today's real, all-false
  state and `run()` checking it against `REQUIRED_CAPABILITIES` before touching
  `execFn` at all — the real `duo-agents redteam` invocation shape is written and
  correct, verified against the actual built binary's `--help`, so flipping a
  capability later is a one-line change, not a rewrite).
- `test/integration/duo-llm-remediation-slice.test.ts` — the real captured report,
  including its one genuine reasoning-DoS hit, commits and replays through the
  unmodified Phase 4 world reducer and lands as `ObservationUnverified` on every
  single result; separately, `DuoLlmCliAdapter.run()` is shown to never invoke a
  live process at all.

**What's honestly not here**: `duo-agents`' Rust internals were not touched — no
real `TargetProvider`, no wiring for `strategies`/`domains`, no additional graders,
no DTO version field. That is a separate codebase's remediation work, not something
a TypeScript ACL can retrofit from outside. Independently of that, this phase's
work on `EXECUTION_SAFETY_RECOVERY.md` — the newly-introduced Phase 4.5
execution-safety admission gate, merged into `main` while this phase was in
progress — states directly: "Изменения сначала применяются к Promptfoo... Duo, MCP
и будущие engines admit только после прохождения тех же contracts." RTAP's own
`ExecutionAttempt`/lease-fencing/`EffectReceipt` machinery doesn't exist yet either,
so `DuoLlmAdapter` would not be admissible to real dispatch even if `duo-agents`
fixed all four Phase R gates on its own side tomorrow — a second, independent
reason the quarantine stays, noted directly in `run.ts`'s doc comment.

## What's here (Phase 4.5.1 — Execution identity and fencing)

`EXECUTION_SAFETY_RECOVERY.md` is a new, mandatory hardening/admission gate inserted
between Phase 4 and Phase 5 (it does not renumber Phase 0–7) — it landed via a
merged branch mid-session, and its own §16 "Delivery sequence" splits the gate into
four numbered sub-phases: **4.5.1** Identity and fencing, **4.5.2** Effect journal
and recovery, **4.5.3** Authorization and scheduling, **4.5.4** Interceptors and
operations. This delivery is **4.5.1 only** — the doc is explicit that Phase 5 stays
inadmissible until *all four* sub-phases and all twelve §14 laws pass (§15's
admission criteria), and Phase 5 already shipped earlier in this project, before
this gate existed. This section does not claim Phase 5 is retroactively admissible;
it claims 4.5.1 is real and correct, and lists exactly what's still missing to reach
that bar.

- `RunStep` gains a genuine `leaseGeneration` — distinct from the pre-existing
  `attempt` counter, which §4.1 explicitly disqualifies as a fencing token ("two
  workers can locally see the same number"). Same trigger as `attempt` (every
  successful `lease()` claim, fresh or takeover-after-expiry), but this is the value
  everything below trusts for staleness.
- `src/execution/` — `ExecutionAttemptStore`, SQLite-backed, layered on
  `RunStepStore` rather than duplicating its lease bookkeeping: `start()` reads the
  RunStep's *current* `leaseGeneration` once and stores it on the attempt; nothing
  ever goes back and marks an old attempt "superseded" when a new lease is issued —
  `bindNativeResult()` derives staleness by comparing against the RunStep's *live*
  generation at bind time, exactly matching §7.1's sequence diagram, which was
  turned directly into a test (`test/execution/execution-attempt-store.test.ts`'s
  "the exact lease-takeover sequence" case). `markTerminal()` enforces "attempt
  immutable after terminal" — a second call throws rather than silently
  overwriting. `bindNativeResult()` implements §7.2's fencing algorithm points 1–5
  (points 6–8 — authorization revocation, artifact digest, already-committed
  dedup — belong to 4.5.2/4.5.3 or are already covered by existing idempotent-commit
  logic) and writes a quarantine record on every rejection as its own side effect,
  not a separate step a caller could forget.
- `schemas/observation.schema.json` gains an optional, nullable `executionAttemptId`
  — additive, not required, so every existing adapter (promptfoo/duo-static/duo-llm)
  keeps validating and committing exactly as before without any changes to their
  `ParsedObservation` shapes.
- `src/pipeline/commit-fenced-observation.ts` — `commitFencedObservation()`, a new
  wrapper around the existing, unmodified `commitObservationWithEvent()`: it calls
  `bindNativeResult()` first and only commits if fencing permits, populating
  `executionAttemptId` on the stored Observation. The pre-existing function is still
  there and still used exactly as before by anything that doesn't route through this
  wrapper — see the gap below.
- Two of §14's twelve laws are implemented for real: `redteam.execution/late-result-
  from-old-lease-is-rejected` and `redteam.execution/observation-binds-active-
  attempt`, both property-based against randomized takeover sequences. The other ten
  are registered `pending`, each citing the specific 4.5.2/4.5.3/4.5.4 mechanism it
  needs (EffectReceipt, AuthorizationReceipt, scheduler concurrency classes,
  InterceptorPlan, OperationalEnvelope) — visible in `npm run laws`, not silently
  dropped. 47 laws total, 33 implemented, 14 pending.
- `test/integration/execution-safety-slice.test.ts` — §7.1's late-result scenario
  end-to-end: worker A's lease expires, worker B takes over, A's late result is
  quarantined and never becomes an Observation, B's result commits and replays into
  the unmodified Phase 4 world reducer.

**What's honestly not here**: this is 4.5.1 of 4. Not built: `EffectReceipt` and the
effect lifecycle state machine, adapter-declared recovery capabilities and the
Recovery Reconciler, `UNKNOWN_EFFECT_OUTCOME`, `AuthorizationReceipt`,
`ConcurrencyDeclaration`/scheduler barriers, `InterceptorPlan`,
`OperationalEnvelope`, the crash-injection matrix, the runbook, and the rollback
drill — all twelve items in §15's admission criteria require these, so Phase 5 does
not become newly admissible by this delivery alone. Also not done: wiring
`commitFencedObservation()` into the promptfoo/duo-static/duo-llm adapters' actual
call sites — the mechanism is real and tested standalone, but no existing adapter
was changed to route through it yet, so `executionAttemptId` is `null` on every
Observation those adapters produce today. `effectId`/`policySnapshotRef`/
`targetSnapshotRef`/`interceptorPlanGeneration`/`concurrencyClass` are structurally
present on `ExecutionAttempt` (§4.2 defines them as one struct) but accepted from
the caller and stored, not validated or acted on — that starts in 4.5.2–4.5.4.

## What's here (Phase 4.5.2 — Effect journal and recovery)

Second of the gate's four sub-phases (§16). Builds on 4.5.1's `ExecutionAttempt`/
fencing without changing any of it — everything below is additive.

- `src/execution/effect.ts` — the §5.1 effect lifecycle as a literal state machine,
  same pattern as `promotion/types.ts`'s model-promotion transitions: a table plus a
  pure `attemptEffectTransition()` that rejects an undeclared event rather than
  coercing it. This makes `redteam.execution/effect-start-is-not-commit` true
  structurally — there is no single event from `EFFECT_STARTED` that reaches
  `OBSERVATION_COMMITTED`, so the law is really checking the table's shape, not a
  remembered assertion. Also carries the full §5.3 terminal-reason taxonomy (already
  anticipated in 4.5.1's `TerminalReason` type, so no change needed there) and the
  §6 `EffectCapability`/`EffectReceipt` types.
- `src/execution/capability-declarations.ts` — a plain lookup from
  `(engineAdapterId, operationFamily)` to `EffectCapability`, defaulting undeclared
  operations to `AT_MOST_ONCE_UNPROVEN` exactly as §6 specifies. Caught and fixed a
  real bug while writing its own test: the first version's key was a naive
  `` `${a}:${b}` `` join, which collides (`{a:'x:y', b:'z'}` and `{a:'x', b:'y:z'}`
  both join to `"x:y:z"`) — now `JSON.stringify([a, b])`, collision-free for any
  string content.
- `src/execution/effect-receipt-store.ts` — SQLite-backed `EffectReceiptStore`, one
  row per `effect_id`, updated in place as more is learned (not appended) since an
  effect has exactly one current understanding of its own outcome at any time.
- `src/execution/reconciliation.ts` — `decideRecovery()`, a pure function
  implementing §12's recovery flowchart exactly: its five actions are the
  flowchart's five terminal nodes (retry / query / compensate / unknown / proceed).
  `effectStarted` is deliberately three-valued (`true | false | null`) because
  §7.2/§13 are explicit that "absence of an ACK does not prove absence of an
  effect" — the *only* way to get `false` is a receipt that says
  `FAILED_BEFORE_EFFECT`, or a query that confirms absence, never merely "no
  receipt was found." `terminalReasonFor()` is kept separate from the decision
  itself, and distinguishes *proven* absence (`FAILED_BEFORE_EFFECT`) from a retry
  that's merely capability-safe without proof (`UNKNOWN_EFFECT_OUTCOME`) — retrying
  safely is not the same claim as having disproven the original effect.
- `src/execution/reconciler.ts` — `EffectReconciler`, the actual Recovery
  Reconciler: reads an attempt's `EffectReceipt` (never process memory), short-
  circuits straight to "proceed" if the receipt already says `CONFIRMED`, otherwise
  calls `decideRecovery()` and marks the *old* attempt terminal via 4.5.1's own
  `markTerminal()`. It deliberately does not create the retry attempt or run
  compensation itself — §12 leaves "new attempt, new lease generation, or run under
  the current owner per scheduler policy" to the caller, since that's a scheduling
  decision that belongs to 4.5.3, not the reconciler.
- `commitFencedObservation()` now marks a successful attempt terminal with reason
  `COMPLETED` — a small, necessary addition (impossible before `TerminalReason`
  existed in 4.5.1): without it, a successfully-committed attempt stayed
  indistinguishable from a merely-active one, which the reconciler needs to tell
  apart (`reconcile()` refuses to run on an already-terminal attempt).
- Six more of §14's twelve laws move from pending to implemented:
  `effect-start-is-not-commit`, `unknown-effect-is-not-auto-retried`,
  `retry-follows-adapter-capability`, `effect-id-stable-only-for-safe-retry`,
  `recovery-preserves-single-observation`, `replay-preserves-effect-resolution` —
  the last two are genuine end-to-end properties over randomized 0–4-round
  crash/retry scenarios, not narrow unit checks. 47 laws total, 39 implemented, 8
  pending (only `authorization-precedes-effect`/`unknown-concurrency-is-exclusive`
  [4.5.3] and `interceptor-order-is-deterministic`/`telemetry-is-not-authority`
  [4.5.4] remain, plus the four pre-existing Phase 0/1 gaps).
- `test/execution/crash-kill-points.test.ts` — §13's crash matrix, for the rows
  4.5.2 actually introduces machinery for (dispatch-before-local-write,
  effect-before-ACK, ACK-before-result). "The reconciler works from durable state,
  not process memory" (§12) means a crash *is* exactly characterized by what got
  durably written before it — so each test constructs precisely the DB rows that
  kill point implies and checks the reconciler reaches the doc's stated outcome; no
  real process is killed, none needs to be, given that stated equivalence.
- `test/integration/effect-recovery-slice.test.ts` — one concrete walkthrough: an
  attempt dispatches, crashes before ACK, gets reconciled (retry sanctioned by
  `IDEMPOTENT_BY_KEY`), a genuinely new attempt retries with the same effect id and
  succeeds, and the result replays through the unmodified Phase 4 reducer exactly
  once.

**What's honestly not here**: still only 2 of 4 sub-phases — `AuthorizationReceipt`,
`ConcurrencyDeclaration`/scheduler barriers, `InterceptorPlan`, `OperationalEnvelope`,
the runbook, and the rollback drill are all still missing, so Phase 5 remains
inadmissible by §15's criteria. `EffectReconciler` also isn't wired into any real
adapter call site — like `commitFencedObservation` in 4.5.1, it's a real, fully
tested mechanism nothing yet calls from promptfoo/duo-static/duo-llm's own code.
The "after native result persistence, before normalization" and "after
normalization, before commit" crash-matrix rows aren't given dedicated new tests —
they're schema-validation and atomic-transaction concerns already covered by
`ObservationStore`/`commitObservationWithEvent`'s pre-existing tests, and 4.5.2
didn't change either mechanism.

## What's here (Phase 4.5.3 — Authorization and scheduling)

Third of the gate's four sub-phases (§16). Additive on 4.5.1/4.5.2, and reuses
Phase 7's `AuthorizationProvider`/`AuditLog` rather than inventing a parallel policy
mechanism — §8's "RTAP policy authorization" stage *is* the same
`'run-step:dispatch'` action Phase 7 already named.

- `src/execution/authorization.ts` — §8.1's `AuthorizationReceipt` verbatim
  field-for-field (`adapterIdentity` split into id/version, matching
  `ExecutionAttempt`, so a version/digest mismatch is a direct field comparison, not
  string parsing). `evaluateAuthorization()` implements §8's four-stage pipeline —
  schema validation, adapter capability digest match, RTAP policy authorization (via
  an injected `AuthorizationProvider`), sandbox/egress constraints — fail-closed at
  every stage: anything that can't be evaluated as an explicit pass is a rejection,
  never a default allow. The sandbox/egress stage requires *both* refs to be
  non-null before authorizing — a real, if minimal, "fail-closed defaults" check
  (RTAP won't authorize an effect whose sandbox/egress posture isn't even declared),
  not enforcement of actual sandboxing, which is out of scope (no sandbox
  infrastructure exists to enforce against).
- `src/execution/authorization-receipt-store.ts` — SQLite-backed, immutable once
  issued (no update method). `isReceiptValid()`/`receiptCoversAdapter()` are pure
  helpers for §8's expiry and version/digest-mismatch rules — not wired into a
  dispatch loop (none exists yet), but real and directly tested.
- `src/execution/concurrency.ts` — `ConcurrencyDeclaration` (reuses the
  `ConcurrencyClass` type `ExecutionAttempt` has carried since 4.5.1).
  `normalizeConcurrencyClass()` is the literal `UNKNOWN -> EXCLUSIVE` rule.
  `reservationsConflict()` is a deliberately *symmetric* pairwise check — "does A
  block B" and "does B block A" must always agree, so it's one function, not two —
  encoding that `TARGET_SERIAL`/`CAMPAIGN_SERIAL` conflict with *anything* sharing
  their resource key/campaign regardless of the other side's own class (the whole
  point of "at most one effect on this target/campaign"), while two
  `READ_ONLY_PARALLEL` reservations never conflict with each other.
  `strictestClass()` implements "for several declarations, the strictest class
  applies" for one operation carrying more than one declaration (e.g. a
  target-scoped one and a campaign-scoped one at once).
- `src/execution/concurrency-scheduler.ts` — `ConcurrencyScheduler`, SQLite-backed
  (durable by design: §9 says a reservation "is released only after terminal
  resolution or an explicit recovery takeover," never by a worker lease merely
  expiring — an in-process `Set` would lose that guarantee across a restart).
  `reserve()` combines a candidate's declarations to their effective strictest class
  and unioned resource keys, checks it against every currently-active reservation
  via `reservationsConflict()`, and separately bounds `READ_ONLY_PARALLEL` by
  `maxInFlight` when one is declared.
- Both of §14's remaining pre-4.5.4 laws move from pending to implemented:
  `authorization-precedes-effect` (property-tested against a real
  `RoleBasedAuthorizationProvider`, not a stub — random role/tenant/digest/sandbox
  combinations, checked against an independently-derived expected outcome) and
  `unknown-concurrency-is-exclusive` (an `UNKNOWN` declaration is shown to behave
  exactly as `EXCLUSIVE` would in the real scheduler, both as a blockER and as
  something that gets blocked). 47 laws total, 41 implemented, 6 pending — only
  `interceptor-order-is-deterministic`/`telemetry-is-not-authority` (4.5.4) and the
  four pre-existing Phase 0/1 gaps remain.
- `test/integration/authorization-and-scheduling-slice.test.ts` — a VIEWER and a
  cross-tenant OPERATOR are both denied dispatch outright; the rightful OPERATOR is
  authorized, reserves a `TARGET_SERIAL` barrier on the target *before* any effect
  starts, a concurrent request on the same target is rejected while the barrier
  holds, and only after the real attempt commits and the barrier is released does
  the blocked request succeed.

**What's honestly not here**: 3 of 4 sub-phases now. Still missing:
`InterceptorPlan`, `OperationalEnvelope`, the runbook, and the rollback drill —
Phase 5 remains inadmissible by §15's criteria until 4.5.4 lands too. Neither
`evaluateAuthorization()` nor `ConcurrencyScheduler` is wired into any real adapter
call site or into `commitFencedObservation`/`EffectReconciler` — each mechanism is
real and independently tested, but nothing yet composes all three into one dispatch
path, since that composition is itself an interceptor-pipeline concern (4.5.4).
"Adapter capability digest" is accepted as an opaque caller-supplied string, not
computed here from any specific capability model (Phase R's engine-level
capabilities and 4.5.2's per-operation `EffectCapability` are both plausible things
it could hash) — deliberately generic rather than picking one and hardcoding it.

## What's here (Phase 4.5.4 — Interceptors and operations)

Fourth and last of the gate's four sub-phases (§16). This completes the *code*
side of every §14 law — 12 of 12 now implemented — but §15 admission has two more
gates than "the laws hold," and this section is explicit about which ones remain.

- `src/execution/interceptor.ts` — `InterceptorDescriptor`/`InterceptorPlan` (§10,
  verbatim). `SideEffectPolicy` has no variant for arbitrary code execution at all —
  "arbitrary shell/HTTP hook is forbidden in the canonical transaction path" is
  enforced by the type having no escape hatch, not by a runtime check on an
  otherwise-unrestricted callback. `compilePlan()` is a pure function of the
  descriptor *set*: sorting by stage (§10's own listed order) then by
  `interceptorId` before hashing means the same descriptors always produce the
  same `orderedDescriptors` and the same `planDigest` regardless of what order they
  were supplied in — this is what makes
  `redteam.execution/interceptor-order-is-deterministic` true structurally, the
  same way `effect.ts`'s state machine made `effect-start-is-not-commit` structural
  in 4.5.2. It also rejects any `POST_OBSERVATION_COMMIT` descriptor that declares
  `CANONICAL_MUTATION` — §10: "cannot roll back committed truth."
  `evaluateStageOutcomes()` implements "security-critical is fail-closed, advisory
  may fail-open only with a typed diagnostic," including treating a
  `SECURITY_CRITICAL` interceptor with *no* reported outcome as failed, never as an
  assumed pass.
- `ExecutionAttempt`/`StartAttemptInput` (4.5.1) gain `interceptorPlanGeneration` as
  a real, threaded-through field — §10: "plan generation enters ExecutionAttempt and
  provenance Observation." `commitFencedObservation()` now carries it into
  `provenance.interceptorPlanGeneration` on every commit, reading it from the real
  attempt record rather than hardcoding `null` — it only actually stays `null`
  because nothing dispatches under a compiled plan yet, not because the plumbing is
  missing.
- `src/execution/envelope.ts` — `OperationalEnvelope` (§11, verbatim), built only
  from an `ExecutionAttempt`'s own durable fields. `safeEmit()` is the one place an
  envelope is ever handed to a sink, and it always catches — §11: "telemetry
  failure does not change the Verdict and does not block canonical commit" is
  proven directly by `redteam.execution/telemetry-is-not-authority`: the exact same
  `commitFencedObservation()` scenario run once with no telemetry and once with a
  sink that always throws produces a bit-for-bit identical outcome.
- `src/execution/metrics.ts` — the seven §11 metric names, typed, plus a minimal
  `MetricsRecorder` interface and an `InMemoryMetricsRecorder` for tests. This is
  the contract only, not a Prometheus exporter (no metrics backend exists in this
  repo), and it is **not wired into** `ExecutionAttemptStore`/`EffectReconciler`/
  `ConcurrencyScheduler` — retrofitting instrumentation into three already-shipped,
  tested classes was judged riskier than worth it for metrics that have nowhere
  real to go yet; recording calls are demonstrated standalone and in the
  integration test instead.
- [`RUNBOOK.md`](./RUNBOOK.md) — §15 criterion 13: manual resolution of
  `UNKNOWN_EFFECT_OUTCOME`, grounded in the actual store/reconciler methods, not
  generic incident-response prose. Explicitly tells operators what *not* to do
  (never hand-edit `terminal_reason`, never guess `CONFIRMED` to make an alert go
  away).
- `.github/workflows/rtap-ci.yml` — new: typecheck, test (including
  `crash-kill-points.test.ts`), `npm run laws`, build, and audit, on every push/PR
  touching `rtap/`. This is what makes §15 criterion 11 ("crash matrix runs in CI
  with replayable seeds") true — there was no CI at all for this package before.
  Also fixed `package.json`'s `engines.node` from `>=20` to `>=22`, which was wrong
  — `node:sqlite` (used since Phase 1) requires Node 22; the workflow would have
  failed instantly on a matching-but-stale engines range.
- `src/execution/admission.ts` — `evaluatePhase5Admission()`, §16's "full admission
  suite" bullet taken literally: it runs the real `LawRegistry` and checks all
  fourteen §15 criteria, not just the ten that are law-backed. Criterion 2 ("every
  Observation contains a binding") is deliberately **not** satisfied by the law
  alone — it also requires `promptfooWiredToHardening`, which is false, because the
  law only proves the mechanism works in isolation, not that any real adapter uses
  it. Calling it with no arguments reports the actual, current state of this
  repository: **10 of 14 criteria MET, admissible: false.**
- `test/integration/interceptor-and-envelope-slice.test.ts` — a failed
  security-critical interceptor blocks dispatch; once it passes, dispatch proceeds
  carrying the plan generation, a failing telemetry sink changes nothing about the
  outcome, and the committed Observation's provenance carries the real plan
  generation through to the end.

**What's honestly not here**, per criterion:

- **Criterion 2 / 12 (adapter wiring).** promptfoo/duo-static/duo-llm still don't
  call `ExecutionAttemptStore`/`evaluateAuthorization`/`ConcurrencyScheduler`/
  `compilePlan`. Every 4.5.1–4.5.4 mechanism is real and independently tested, but
  nothing composes them into one live dispatch path for a real adapter — that's a
  distinct integration project, not a mechanism-design one.
- **Criterion 14 (rollback drill).** There is no hardening feature flag, so there is
  nothing for a rollback drill to exercise. Fabricating one just to run a drill
  against it would test the fabrication, not anything real.
- **Metrics are not emitted anywhere real** (see above) — the contract exists,
  nothing calls it outside of tests.
- **No concrete `InterceptorDescriptor` implementations exist** — `inputSchema`/
  `outputSchema` are opaque string refs because there is no real interceptor (an
  egress guard, a usage logger, anything) to validate a schema against yet; the
  compiler/executor are real, what would run through them is not.

Taken together: **the Execution Safety & Recovery gate's code is complete — all
twelve §14 laws hold — but §15 admission is honestly not met**, and
`evaluatePhase5Admission()` says exactly why, every time it's run, rather than
letting "the laws pass" be quietly mistaken for "Phase 5 is safe to enable."

## Bug fix: target-scoped binding and dispatch dedup

Not a wiki phase — a remediation for a real, active correctness bug an audit of
this repository found and this session independently verified against the code
before fixing it. Summary of the audit's finding: `RecommendationBinding` had no
`targetId` field, candidate eligibility was keyed by bare `probeId`, and the
Planner's dispatch idempotency key was `${probeId}:${arm}:${policyVersion}` — none
of it target-aware. In a multi-target campaign this was not a theoretical risk:

- **Silent work loss.** Dispatching the same probe against Target B after Target A
  produced the *same* idempotency key, so `RunStepStore.enqueue()` returned Target
  A's existing step as a dedup — Target B's unit of work was never created.
- **Wrong eligibility.** `CampaignHistoryView.byProbe` aggregated attempts/confirmed-
  findings across every target in the campaign. A probe confirmed VULNERABLE
  against Target A was excluded from Target B's candidate pool even though it had
  never run there.
- **Mislabeled training data.** `computeUtilityLabel()` used the same cross-target-
  blind lookup, so a first-ever attempt against Target B scored as
  `independentConfirmation` (a repeat) instead of `newConfirmedFinding`, because
  Target A's confirmation leaked into Target B's label.
- **Biased A/B evaluation.** `joinDispatchWithOutcomes()` joined by bare `probeId`
  too, conflating two different targets' outcomes for the same probe and skewing
  the promotion gate's lift calculation.

Fixed by making `(targetId, probeId)` the candidate identity end to end, not
`probeId` alone:

- `features/history-view.ts` — `byProbe`/`confirmedFindingProbes` renamed to
  `byTargetProbe`/`confirmedFindingTargetProbes`, keyed by the new
  `targetProbeKey(targetId, probeId)` helper (`JSON.stringify`-based, not a
  `${a}:${b}` join — probeId already contains `:`, so a naive join would itself
  collide). `vulnerabilityClassesSeen`/`byTarget` were deliberately left
  campaign-wide — they're diversity/feature signals nothing uses for eligibility,
  not part of the bug.
- `candidates/enumerate.ts` — `enumerateEligibleCandidates()` now takes an explicit
  `targetId`; `EligibleCandidate` carries it.
- `domain/recommendation-binding.ts` — `RecommendationBinding` gains `targetId`, a
  new `target-mismatch` rejection reason, checked in `decideExecution()` right
  alongside the existing `campaignId` check.
- `shadow/signal.ts`/`rank.ts` — `FrozenSignal`/`RankedCandidate` carry `targetId`,
  sourced from `candidate-compiler.ts`'s new `CandidateFeatureSnapshot.
  candidateTargetId` field (added to `schemas/feature-snapshot.schema.json` too,
  conditionally required for `featureView: CANDIDATE`, null for `OBSERVATION`).
- `planner/mixer.ts` — `PlannerDecision` carries `targetId`; the batch-composition
  dedup set (`chosenKeys`) is now `targetProbeKey`-based, not bare-probeId;
  `mandatoryShortfall` is now `{targetId, probeId}[]`, not `string[]`.
- `planner/dispatch.ts` — idempotency key is
  `${targetId}:${probeId}:${arm}:${policyVersion}`; the `RunStep` payload and
  `planner_dispatch_log` (new `target_id` column) both carry `targetId` — a worker
  cannot know what to attack without it, which was simply missing before, not
  optional.
- `planner/ab.ts` — `joinDispatchWithOutcomes()` joins by `targetProbeKey`.
- `training/utility-label-policy.ts` — `LabelInput` gains `targetId`;
  `computeUtilityLabel()` looks up prior attempts/confirmation by
  `targetProbeKey(outcome.targetId, outcome.probeId)`.

New law: `redteam.planner/target-scoped-candidates-are-not-merged` — the same
probeId, eligible for 2-4 different Targets in one batch with deliberately maximal
overlap, produces one decision per Target, never a collapse. 48 laws total, 44
implemented, 4 pending (unchanged from Phase 4.5.4 — none of the four pending laws
are related to this fix). Every touched module also gained a direct regression
test reproducing the exact cross-target scenario the audit described (see
`test/candidates/enumerate.test.ts`, `test/planner/mixer.test.ts`,
`test/planner/dispatch.test.ts`, `test/planner/ab.test.ts`,
`test/training/utility-label-policy.test.ts`, `test/features/history-view.test.ts`).

**What's honestly not here**: the audit's other findings (schema migrations,
merging the fencing check and commit into one transaction, protected-artifact
wiring, full EffectReceipt/AuthorizationReceipt integration into a live adapter)
are separate, not addressed by this fix — see the audit discussion earlier in this
session and the Phase 4.5 sections' own "what's honestly not here" for those.
`planner_dispatch_log`'s new `target_id NOT NULL` column is added via the same
`CREATE TABLE IF NOT EXISTS` pattern every table in this repo uses — it does not
retrofit onto a pre-existing database file with old rows; the audit's own
schema-migrations finding (P0#1) covers exactly this gap and remains unfixed here.

## Bug fix: schema migrations

The audit's P0#1, flagged (and deliberately left unfixed) in the section above:
`CREATE TABLE IF NOT EXISTS`, re-executed on every `openDatabase()` call, is a
no-op the moment a table already exists — every schema change across every phase
in this repo, right up through the previous fix's own `target_id` column, relied
on that guard alone. For a real, persistent SQLite file that already exists, a
later code change adding a column would never actually apply to it; the running
code and the on-disk schema would silently diverge until something crashed on a
missing column.

- `src/db/migrations.ts` — new. A `Migration { id, name, up }` registry,
  `applyMigrations(db, migrations, now)`, and a `schema_migrations` tracking
  table. Migration 1 (`initial_schema`) is the complete schema exactly as it
  stood before this fix, moved here unchanged — there is no earlier deployed
  instance of this database to reconcile against, so this is an honest snapshot
  of "what a fresh install gets today," not a fabricated incremental history.
  Every future schema change is a new migration appended after it, never an edit
  to this one.
- Each migration applies inside its own transaction. SQLite DDL is fully
  transactional, so a migration that creates two tables and then throws rolls
  back *both*, not just the throw — proven directly in
  `test/db/migrations.test.ts`, not asserted from SQLite's documentation alone.
  A failed migration is never recorded as applied, so the next call retries it
  from scratch.
- **Startup refusal for an unsupported version**: if `schema_migrations` already
  contains an id beyond what the running code's migration list defines,
  `applyMigrations()` throws `UnsupportedSchemaVersionError` before touching
  anything — this is what happens when older code opens a database file a newer
  version already migrated. The check runs once, up front, not interleaved with
  applying migrations, so a downgrade is refused atomically.
- `src/db/connection.ts` — reduced to opening the connection, setting PRAGMAs,
  and calling `applyMigrations()`. The actual DDL moved out entirely.
- New law `redteam.platform/schema-migrations-apply-exactly-once-in-order` —
  a random number of migrations, supplied in a random order, always end up
  applied exactly once each in ascending id order, and a second call is a
  complete no-op. 49 laws total, 45 implemented, 4 pending (unchanged).
- `test/db/migrations.test.ts` — beyond the rollback and refusal cases above, a
  direct N→N+1 upgrade test: migration 1 creates a table and a row is inserted;
  migration 2 (`ALTER TABLE ... ADD COLUMN`) is applied to the *same* database
  afterward; the pre-existing row survives untouched and the new column is
  usable for new rows — the exact scenario `CREATE TABLE IF NOT EXISTS` could
  never have handled.

**What's honestly not here**: no real deployment of this database has ever
existed to migrate, so this is a tested, ready mechanism, not something a
persistent RTAP instance has actually been upgraded through yet. Migration 1's
content is unchanged from before this fix — this delivery doesn't add or remove
any table or column, only the tracking around how schema changes get applied.

## Bug fix: fenced commit is the sole canonical API

The audit's #2: `commitObservationWithEvent()` and `commitFencedObservation()`
coexisted as two separately-transactional commit paths. Concretely, the old
`commitFencedObservation()` did three separate things, not one: (1) call
`ExecutionAttemptStore.bindNativeResult()` — its own reads, and on rejection its
own quarantine insert; (2) call `commitObservationWithEvent()` — a *separate*
transaction inserting the Observation and CampaignEvent; (3) call `markTerminal()`
afterward, once (2) had already committed. Between (1) and (2), a concurrent lease
takeover could have staled the fencing decision before the commit used it (a real
risk for the eventual multi-process PostgreSQL profile, not for this repo's
single-connection SQLite one — see `db/connection.ts`'s own doc comment). Between
(2) and (3), a crash would have left a genuinely committed Observation attached to
an attempt that never got marked `COMPLETED` — a real crash-consistency gap in
*this* profile too, not just a theoretical one.

- `src/pipeline/commit-observation.ts` — the raw insert pair now lives in
  `insertObservationAndEvent()`, deliberately with no transaction management of
  its own (SQLite doesn't support nesting a `BEGIN` inside an open transaction, so
  a shared non-transactional primitive is what lets two different callers each
  wrap it in their own outer transaction). `commitObservationWithEvent()` itself
  is unchanged in behavior — still its own single transaction — but is **no
  longer exported from the package's public barrel** (`src/index.ts`): it was
  never wired to any adapter and isn't the production path. It stays a real,
  tested module function because `commitFencedObservation()` is built directly on
  it, and a real set of pre-4.5 tests (`test/commit-observation.test.ts`, the
  Phase 1/6/R vertical slices) legitimately test this exact primitive for phases
  that predate fencing entirely — removing it would delete real coverage of a
  still-real mechanism, not just an unused API.
- `src/pipeline/commit-fenced-observation.ts` — now **is** the sole canonical
  commit path. The fencing check, the Observation/CampaignEvent insert, and
  `markTerminal()` all happen inside one `BEGIN IMMEDIATE`/`COMMIT` — a rejected
  bind still commits its quarantine record (real, durable audit data, not
  discarded), but everything past an *accepted* bind is now genuinely one unit:
  a failure anywhere in it rolls back the whole thing, including the Observation
  insert that already ran. No separate "lease owner" field was added —
  `executionAttemptId` is an unguessable UUID minted fresh per attempt, so
  possessing a valid one already is the ownership proof this repo's single-process
  model needs; `leaseGeneration` is what enforces exclusivity. An outbox row
  (the audit's step 5) is not part of this commit — no outbox table exists yet;
  that is the audit's separate, larger "real outbox and CampaignWorld
  materializer" item, not fabricated here to pad out the transaction.
- New law `redteam.execution/fenced-commit-is-a-single-transaction` — across a
  rejected bind, a full success, and a mid-commit failure (a malformed
  CampaignEvent, discovered only after the Observation insert already ran), the
  Observation's existence, the CampaignEvent's existence, and the attempt's
  `COMPLETED` state always agree: all three or none, never a subset. 50 laws
  total, 46 implemented, 4 pending (unchanged).
- `test/pipeline/commit-fenced-observation.test.ts` — new, direct unit coverage
  the module never had before (only integration slices and the law above
  exercised it). Its central case: an Observation insert that succeeds followed
  by a CampaignEvent insert that fails schema validation, still inside the same
  transaction `commitFencedObservation()` opened — the Observation is rolled back
  too, the attempt stays non-terminal, and a retry with the same
  `executionAttemptId` succeeds cleanly afterward.

**What's honestly not here**: no adapter (promptfoo/duo-static/duo-llm) calls
`commitFencedObservation()` — there still isn't a production orchestrator
connecting any adapter's parsed output to *any* commit function; only tests do,
same as every phase since 4.5.1 has documented. "Closing the unfenced path" here
means the public API surface no longer *offers* an alternative, not that
production code has been rewired to something that didn't exist to rewire. The
audit's outbox item (its step 5, a real `outbox` table and delivery worker) is
untouched — deliberately, so this fix stays about transaction boundaries, not
scope-creep into building an outbox to fill out an atomic step list.

## Bug fix: real outbox and CampaignWorld materializer

The audit's #4, and the item the two fixes above both explicitly deferred: no
`outbox` table existed, and nothing incrementally materialized `CampaignEvent`s
into a persisted `CampaignWorldState` — `world/replay.ts`'s `replay()` was (and
remains) the only path from events to a world, and it always rebuilds from
`emptyWorld()`. A real deployment replaying its entire event history on every
read is not what ADAPTIVE_REDTEAM_RUNTIME.md §6 describes ("durable publisher +
incremental materializer + persisted cursor"); this fix builds that, without
touching `replay()` itself, which stays the correct tool for full reconstruction
and verification (`world/snapshot.ts`'s `verifySnapshot()` still uses it that way).

- `src/db/migrations.ts` — migration 2 (`outbox_and_materializer`), the first
  real (non-test) use of the migration mechanism the schema-migrations fix
  built: an `outbox` table (`event_id UNIQUE`, `campaign_id`, `sequence`,
  `created_at`, `delivered_at`) and a `materialized_worlds` table
  (`campaign_id` primary key, `generation`, `epoch`, `last_sequence`,
  `state_json`, `updated_at`) — the persisted cursor *is*
  `materialized_worlds.last_sequence`; there is no separate cursor row.
- `src/events/store.ts` — `CampaignEventStore.append()` now inserts an outbox
  row unconditionally, immediately after the `campaign_events` insert, using
  the same `this.db` and no transaction of its own. Because `append()` never
  opens a `BEGIN`, this row lands inside whatever ambient transaction the
  caller already has open — for the production path, that's
  `commitFencedObservation()`'s single transaction — so "Observation +
  CampaignEvent + OutboxRow, atomic" is true for every committed event without
  either commit function needing to know the outbox exists.
- `src/events/outbox.ts` — new `OutboxStore`: `listUndelivered(campaignId)`,
  `listAll(campaignId)`, `markDelivered(eventIds, now)`. Read-only with respect
  to row creation — only `CampaignEventStore.append()` inserts rows; this store
  only reads and marks delivery, which is what lets it recover cleanly from an
  arbitrarily long gap between an event being committed and being materialized.
- `src/world/materializer.ts` — new `CampaignWorldMaterializer`. `current(campaignId)`
  reads the last persisted world; `advance(campaignId, now)` loads it (or
  `emptyWorld()` if none exists yet), asks the outbox for everything undelivered
  past its `lastSequence`, applies each via the same `applyEvent()` `replay()`
  uses (same idempotency, same strict-gap-stops-not-skips behavior), persists the
  new world and marks the applied rows delivered — all inside one
  `BEGIN IMMEDIATE`/`COMMIT`. A crash between persisting the world and marking
  rows delivered is self-healing: those rows are still undelivered next time,
  `applyEvent()`'s own idempotent-duplicate handling absorbs the redundant
  re-application, and they get marked delivered again on the next `advance()`.
- New law `redteam.platform/outbox-materialization-matches-full-replay` — a
  random real event stream, committed through the real `CampaignEventStore`,
  materialized incrementally (split across 1-4 `advance()` calls against fresh
  `CampaignWorldMaterializer` instances sharing one database, simulating a
  crash and restart mid-stream) always fingerprints identically to
  `replay()`'s from-scratch reconstruction of the same events. 51 laws total,
  47 implemented, 4 pending (unchanged).
- `test/events/outbox.test.ts`, `test/world/materializer.test.ts` — direct unit
  coverage, including a resumption test: a second `CampaignWorldMaterializer`
  instance, constructed fresh over the same database after more events were
  committed, applies only the new events, proving resumption comes from the
  persisted cursor and not from in-process object state.
- `test/integration/outbox-materializer-slice.test.ts` — end to end through the
  real commit path: `commitFencedObservation()` → outbox row appears
  automatically → `advance()` materializes it; a rejected/quarantined commit
  never reaches the outbox at all (it never reaches the event log either); and
  several commits, each followed by its own `advance()` call, fingerprint-match
  a full replay at the end.

**What's honestly not here**: nothing calls `advance()` in production — same gap
as every commit-path fix so far, there is no scheduler or background worker
invoking the materializer periodically or after each commit; a caller (test or
future orchestrator) must call it explicitly. `materialized_worlds` is a
genuinely new persisted-state table, distinct from `world/snapshot.ts`'s
`WorldSnapshot` (which deliberately carries no entities/relations, by design —
see that module's own doc comment); the two are not merged and don't need to be.
No compaction or retention policy exists for `outbox` rows once delivered — they
accumulate forever, same honestly-unaddressed gap the migrations fix's own
`schema_migrations` table has.

## Bug fix: ArtifactStore wired to adapter evidence

The audit's #5: `ArtifactStore` (Phase 7 — a real, tested, content-addressed
filesystem store, see `artifacts/store.ts`'s own doc comment) and every adapter's
`parse.ts` Anti-Corruption Layer have coexisted since Phase 7 without ever being
connected. Every adapter has only ever produced synthetic string EvidenceRefs —
`promptfoo:${nativeRunId}:${nativeResultId}`, `duo-static:${scan.id}:report`,
`duo-llm:${report.id}:${index}:prompt` — that look like refs but resolve to
nothing: calling `store.get()` on any of them throws `MalformedArtifactRefError`,
not "not found," because they were never even shaped like a real one. This fix
makes every EvidenceRef a real one.

- `src/artifacts/materialize.ts` — new, adapter-agnostic `materializeEvidence(store,
  assessmentRunId, bodies)`: writes each `{kind, body}` to `store` and returns real
  refs in the same order. Same-content bodies converge to the same ref for free
  (`FilesystemArtifactStore`'s own content-addressing), so a caller that reuses
  one body across many observations — a whole native report shared by every
  finding/result derived from it — pays no duplication cost for doing so.
- `src/adapters/promptfoo/evidence.ts`, `duo-static/evidence.ts`,
  `duo-llm/evidence.ts` — one `materialize*Evidence()` function per adapter, each
  taking the already-parsed `ParsedObservation` plus the native record(s)
  `parse.ts` derived it from, and returning a new `ParsedObservation` with real
  refs in place of the synthetic ones:
  - **promptfoo**: the complete native `EvaluateResult` record, as `native-report`
    — the only real evidence this adapter's minimal type slice carries; there is
    no separately-addressable prompt/response text to split out.
  - **duo-static**: `finding.code_snippet` as `snippet` *only when the scanner
    actually captured one* (it's nullable — a finding with none gets no
    fabricated snippet ref, just `native-report`), plus the whole `scan` record
    as `native-report`, shared across every finding in that scan.
  - **duo-llm**: `attack.prompt` as `payload`, `response` as `response` — both
    real text this adapter's native type already carries — plus the whole
    `report` as `native-report`, shared across every result in it.
  - None of the three touch `parse.ts` itself — the pure, synchronous ACL
    functions are unchanged, still return synthetic refs on their own, and stay
    directly testable without a store. `materialize*Evidence()` is a separate,
    additive, async post-processing step a caller opts into.
- New law `redteam.artifact/adapter-evidence-is-really-stored` — the general
  `materializeEvidence()` path: for a random number of bodies of random declared
  `EvidenceKind`s, every returned ref resolves via `store.get()` to the exact
  bytes it was given, in order, and a second call with identical bodies always
  lands on the same refs. 52 laws total, 48 implemented, 4 pending (unchanged).
- `test/artifacts/materialize.test.ts`, `test/promptfoo-evidence.test.ts`,
  `test/duo-static-evidence.test.ts`, `test/duo-llm-evidence.test.ts` — direct
  unit coverage per adapter against the same real captured fixtures the existing
  `parse.ts` tests use, including the shared-native-report-ref case for
  duo-static/duo-llm and the no-fabricated-snippet case for duo-static.

**What's honestly not here**: no adapter's `run.ts` or any orchestrator calls
`materialize*Evidence()` — same gap as every adapter/pipeline fix so far, there is
still no production code connecting a CLI adapter's output to *any* commit
function, so there is nothing yet that would call this either; only tests do.
`commitFencedObservation()`'s `Observation.evidenceRefs` field still accepts
whatever a caller passes it — this fix makes real refs available to produce, it
does not make fake ones impossible to pass, since nothing enforces that a
committed Observation's refs actually came from `materializeEvidence()`. The
audit's #7 (authorization/scheduler wired into the pipeline) is the other
untouched wiring item, and is not addressed here.

## Bug fix: authorization and scheduler wired into the dispatch pipeline

The audit's #7, and the last of its P0 wiring items. `evaluateAuthorization()`
and `ConcurrencyScheduler` (both 4.5.3) have been real, independently-tested
mechanisms since Phase 4.5.3 — and rtap/README.md said, in that section and
again in 4.5.4's and the admission suite's own sections, that nothing composed
them together: "neither is wired into any real adapter call site or into
`commitFencedObservation`/`EffectReconciler`." The only place they had ever run
in the same test was `authorization-and-scheduling-slice.test.ts`, calling both
by hand, in the right order, with a hand-picked placeholder `executionAttemptId`
for the reservation because no real attempt existed at that point in the test.
This closes that gap with a real function, not a bigger test.

- `src/execution/dispatch.ts` — new `admitDispatch()`. Follows
  EXECUTION_SAFETY_RECOVERY.md §5.1's own state diagram order
  (`ADMITTED -> AUTHORIZED -> EFFECT_STARTED` / `ADMITTED -> REJECTED`): an
  `ExecutionAttempt` is always created first — durable proof a dispatch was
  attempted, even if it goes no further — then `evaluateAuthorization()`, then
  `ConcurrencyScheduler.reserve()` with the *real* `executionAttemptId` this time,
  not a placeholder. A rejection at either gate immediately terminalizes the
  attempt with the exact reason: `AUTHORIZATION_DENIED` or `TARGET_UNAVAILABLE` —
  both real `TerminalReason` values `execution/types.ts` has declared since
  4.5.1/4.5.2 that nothing had ever actually set until this function existed.
  Grepping the repo before this fix confirmed it: `FAILED_BEFORE_EFFECT` was
  already used (by the 4.5.2 reconciler, for a different scenario), but
  `AUTHORIZATION_DENIED`/`TARGET_UNAVAILABLE`/`CAPABILITY_UNSUPPORTED` were dead
  values in the type only. A rejection at the authorization stage never reaches
  the concurrency stage at all — no reservation is attempted, let alone left
  behind.
- `src/pipeline/commit-fenced-observation.ts` — `commitFencedObservation()` gains
  an optional `dispatchGuard: {scheduler, reservationId}` parameter (fully
  backward compatible — every existing caller omits it and behaves exactly as
  before). On the success path only, it releases the reservation `admitDispatch()`
  reserved, inside the *same* transaction as marking the attempt `COMPLETED` —
  `ConcurrencyScheduler.release()` opens no `BEGIN` of its own, so it joins this
  transaction exactly the way `insertObservationAndEvent()` and the outbox insert
  already do, making §9's "released only after terminal resolution" atomic with
  the resolution itself. Deliberately *not* released on the reject branch: a
  fencing rejection doesn't tell this function whether the attempt that held the
  reservation actually resolved some other way (one of its own rejection reasons
  is literally `ATTEMPT_ALREADY_TERMINAL`) — a caller whose guarded attempt ends
  in FAILED/CANCELLED/quarantined still must call `scheduler.release()` itself.
- Caught in this fix's own new code before it shipped: `admitDispatch()`
  originally called `attempts.markTerminal()` on rejection but returned the
  *pre-termination* `attempt` object it had captured earlier, still showing
  `terminalReason: null` — discarding `markTerminal()`'s own return value. Found
  by a test that checked the returned object directly rather than re-fetching
  from the store afterward; fixed to return `markTerminal()`'s result.
- New law `redteam.execution/dispatch-admission-composes-authorization-and-concurrency`
  — across random role/tenant/pre-existing-conflict combinations: an unauthorized
  principal is always rejected at `AUTHORIZATION` without ever touching the
  reservation count; a conflicting request is always rejected at `CONCURRENCY`
  without disturbing the existing holder or leaving a phantom reservation; a
  clean request always creates exactly one reservation correctly attributed to
  the real attempt, whose `terminalReason` is `null`. 53 laws total, 49
  implemented, 4 pending (unchanged).
- `test/execution/dispatch.test.ts` — direct unit coverage of all four outcomes.
  `test/pipeline/commit-fenced-observation.test.ts` — three new cases: the guard
  releases on success, an unguarded commit leaves any reservation untouched (the
  release is opt-in), and a rejected bind does not release a guard's reservation.
  `test/integration/authorization-and-scheduling-slice.test.ts` — a new case
  running the full `admitDispatch()` → `commitFencedObservation(dispatchGuard)`
  → replay path end to end, alongside the original hand-composed test (left
  intact — it still demonstrates the underlying mechanisms independently).

**What's honestly not here**: `evaluatePhase5Admission()`'s criteria 2 and 12
stay `NOT_MET`, unchanged and correctly so — `promptfooWiredToHardening` is still
`false`, because `admitDispatch()` is a new, generic composition primitive that
no adapter (`adapters/promptfoo/run.ts` or otherwise) has been changed to call.
That is a distinct, larger integration project this fix does not attempt, same
as every adapter-wiring gap this repo has honestly flagged since 4.5.1. This
also does not touch `EffectReconciler` — a recovered attempt's reservation
release, on any path other than a fresh success through
`commitFencedObservation()`, is still the caller's own responsibility. With
this, every audit P0 item has a real fix except #3's remainder: #1, #2, #4, #5,
and #7 above are fully addressed, #6 was already resolved before the audit ran,
and #3's core bug (target-scoped binding/dedup) was fixed earlier — its
additional field-list extension (candidateId, targetSnapshotRef,
worldFingerprint, featureDigest, compilerDigest, modelGeneration,
createdAt/expiresAt) remains open, left that way deliberately when asked.

**CI fix, same push**: the #7 commit above broke CI — `test/laws.test.ts` and
`test/execution/admission.test.ts` each run the entire `LawRegistry` at least
once, a cost that grows with every law this repo adds, and the registry
crossing ~50 laws pushed both past Vitest's 5000ms default `testTimeout` on
GitHub Actions' runner (measurably slower than local dev machines — both tests
stayed under the limit locally, at ~4-6s, right up against it). New
`vitest.config.ts` sets `testTimeout: 30_000` globally, a fix that scales with
the registry instead of needing a bespoke per-test timeout bump every time a
future phase adds another law.

## Bug fix: RecommendationBinding field-list extension (audit #3 remainder)

The part of the audit's #3 deliberately left open earlier: beyond the
target-scoped binding/dedup bug fix (which added `targetId` to
`RecommendationBinding` itself), the audit's own list named seven more fields —
`candidateId`, `targetSnapshotRef`, `worldFingerprint`, `featureDigest`,
`compilerDigest`, `modelGeneration`, `createdAt`/`expiresAt`. Before writing
anything, checking real code for a source: `RecommendationBinding`'s current
seven fields already are the exact composite key FROZEN_INTEGRATION.md §2/§6
define, strict equality — extending it further would mean redefining what that
document calls the staleness check, not adding provenance alongside it. And of
the audit's seven, real data exists in this codebase for only four:
`worldFingerprint` (`world/fingerprint.ts`'s `fingerprint()`), `compilerDigest`
(`features/candidate-compiler.ts`'s `CANDIDATE_COMPILER_BUILD`), `featureDigest`
(already exists as `FrozenSignal.featureSnapshotRef`, just under a different
name), and `createdAt`/`expiresAt` (a TTL window, the same pattern
`AuthorizationReceipt` already uses). `candidateId`, `modelGeneration`, and
`targetSnapshotRef` have no real source anywhere: candidates are identified
only by the `(targetId, probeId)` pair, models are identified only by
`modelDigest` (a hash, no separate generation counter exists in
`promotion/registry.ts`), and nothing in the planner/shadow path produces a
target snapshot reference the way `execution/authorization.ts`'s
`AuthorizeEffectRequest` does from outside its own pipeline.

- `src/domain/recommendation-provenance.ts` — new. `RecommendationProvenance`
  carries exactly the four derivable fields above, plus `buildRecommendationProvenance()`
  and `isProvenanceFresh()` (mirroring `execution/authorization.ts`'s
  `isReceiptValid()`). **Never checked for equality by `decideExecution()`** —
  this is a record of provenance, not a second staleness gate;
  `RecommendationBinding` alone still decides staleness, unchanged.
- `src/planner/mixer.ts` — `PlannerDecision` gains a `provenance:
  RecommendationProvenance | null` field, populated only for the model arm
  (mirroring how `binding` itself is already `null` for
  mandatory/heuristic/exploration decisions — those never came from a model, so
  neither a binding nor provenance record makes sense for them). `BindingContext`
  gains two *optional* fields, `world?: CampaignWorldState` and
  `compilerDigest?: string` — omitted by every existing caller today (none has a
  real `CampaignWorldState` in hand at this call site yet), which is why this
  required no changes to any existing test or law: every prior `BindingContext`
  literal still type-checks and now simply produces `provenance: null`.
  `mixCandidates()` gains an optional trailing `now` parameter for deterministic
  `createdAt`/`expiresAt` in tests.
- New law `redteam.planner/recommendation-provenance-reflects-its-world` —
  across random worlds and a random choice of whether `BindingContext` supplies
  `world`/`compilerDigest` at all: provenance is `null` whenever either is
  missing (never fabricated), and when both are present,
  `provenance.worldFingerprint` always equals `fingerprint()` of the *exact*
  world instance supplied, `compilerDigest` matches exactly, and
  `isProvenanceFresh()` is true immediately at construction and false exactly at
  (not just after) `expiresAt`. 54 laws total, 50 implemented, 4 pending
  (unchanged).
- `test/domain.test.ts` — direct unit coverage of `buildRecommendationProvenance()`/
  `isProvenanceFresh()`. `test/planner/mixer.test.ts` — coverage of the wiring:
  null when unsupplied, populated and world-matching when supplied, always null
  for the three non-model arms even when both context fields are present.

**What's honestly not here**: `candidateId`, `modelGeneration`, and
`targetSnapshotRef` were not added — see above for exactly why each has no real
source today. Nothing in this pipeline calls `mixCandidates()` with a real
`world`/`compilerDigest` yet either (same gap as every other planner/adapter
fix): `PlannerDecision.provenance` is real machinery, proven correct, that stays
`null` in every current caller until an orchestrator exists to supply a live
`CampaignWorldState` at dispatch time. With this, every audit P0 item and the
#3 remainder have real fixes, fully closing the audit's original list.

## Settlement releases what admission acquired

Not an audit item — the first adoption from
[`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`](../wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md)
§2.1, a second mining pass over `wiki/Arch_claude/` whose candidates were each
adversarially checked against this repo's real source. This one closes a leak the
previous fix (authorization and scheduler wired into the dispatch pipeline) opened
and that `RUNBOOK.md` Part B was written to work around by hand.

The rule was never in doubt — EXECUTION_SAFETY_RECOVERY.md §9 states it, and this
repo restated it twice more (`concurrency-scheduler.ts`'s own doc comment,
`RUNBOOK.md` Part B). What was missing was anything that *did* it.
`ConcurrencyScheduler.release()` had exactly one caller: `commitFencedObservation()`'s
success path, and only when a caller remembered to pass a `dispatchGuard`. Every
other way an attempt reaches a terminal state — `EffectReconciler` resolving it
(which did not have a `ConcurrencyScheduler` at all), a fencing rejection, an adapter
throwing, a cancellation — left `released_at IS NULL` forever. For a
`TARGET_SERIAL`/`CAMPAIGN_SERIAL`/`EXCLUSIVE` class that silently wedges every future
dispatch against that resource, with no error raised anywhere.

- `src/execution/settle.ts` — `settleAttempt(attempts, scheduler, attemptId, reason)`:
  marks the attempt terminal *and* disposes of its barrier, as one operation.
  `markTerminal()` runs first, so "exactly one settlement per attempt" is inherited
  from its existing immutability check rather than re-implemented — and a loser in a
  double-settle race throws before it can release a barrier whose fate the winner
  already decided. Opens no transaction of its own (matching `markTerminal()`/
  `release()`/`bindNativeResult()`), so it lands inside `commitFencedObservation()`'s
  existing `BEGIN IMMEDIATE` and rolls back with it.
- **`UNKNOWN_EFFECT_OUTCOME` deliberately retains its barrier.** This is the one
  reason that must *not* release: §6 calls it "a durable business outcome," the
  effect may still be genuinely in flight, and freeing the target would permit
  exactly the double-dispatch the serial classes exist to prevent. `RETAINED` is a
  first-class variant of the returned `ReservationDisposition`, distinct from `NONE`
  (no barrier existed) — collapsing the two would hide the precise state
  `RUNBOOK.md` Part B exists to resolve. The release/retain split is an exhaustive
  `switch` over `TerminalReason` with a `never` check, so adding a twelfth terminal
  reason will not compile until someone decides which side it falls on.
- `src/execution/concurrency-scheduler.ts` — new `activeReservationForAttempt()`.
  The `execution_attempt_id` column has been on `concurrency_reservations` since
  4.5.3 and nothing ever read it by attempt; now the reservation is found from the
  attempt's own identity. It throws rather than picking arbitrarily if an attempt
  somehow holds two, since silently releasing one of them is the leak this is fixing.
- `src/execution/reconciler.ts` — `ConcurrencyScheduler` is now a **required**
  constructor dependency, not optional: making it optional would leave "forgot to
  pass it" indistinguishable from "there was no barrier." `ReconcileResult` gains
  `reservation`, `null` when the decision did not settle the attempt at all
  (`PROCEED_TO_NATIVE_RESULT`) — a still-running attempt legitimately keeps holding
  its reservation, which is a different thing from a settled one that retained it.
- `src/pipeline/commit-fenced-observation.ts` — the `DispatchGuard { scheduler,
  reservationId }` parameter is **gone**, replaced by a plain optional
  `ConcurrencyScheduler`. Threading a `reservationId` from admission all the way to
  commit was work a caller could get wrong; the reservation is now looked up from
  durable state, so a stale or simply mismatched id is no longer expressible. The
  reject branch still deliberately releases nothing — a fencing rejection (one of
  whose reasons is literally `ATTEMPT_ALREADY_TERMINAL`) does not tell this function
  whether someone else already settled the attempt and owned its barrier's fate.
- New law `redteam.execution/settlement-releases-what-admission-acquired` — over
  random terminal reasons, concurrency classes, and with/without a barrier: the
  disposition matches the durable table rather than merely being reported, no
  terminal attempt is left holding a barrier except the sanctioned
  `UNKNOWN_EFFECT_OUTCOME` case, a retained barrier is genuinely still held, and a
  second settlement is refused. 55 laws total, 51 implemented, 4 pending (unchanged).
- `test/execution/settle.test.ts` — direct coverage, including the two that matter
  operationally: a retained barrier really does still block a competing
  `TARGET_SERIAL` reservation (so `RUNBOOK.md` Part B is genuinely the only way out),
  and a reconciled `FAILED_BEFORE_EFFECT` attempt now leaves zero active reservations
  where before this change it left one.

**What's honestly not here**: `settleAttempt()` is not yet the *only* way an attempt
terminalizes — `admitDispatch()`'s two rejection branches and
`commitFencedObservation()`'s no-scheduler path still call `markTerminal()` directly,
correctly so in the first case (no barrier has been acquired yet at authorization
failure) and by backward-compatible choice in the second. Making the scheduler
mandatory everywhere is a larger change that belongs with the executor
`ARCH_CLAUDE_TRANSFER.md` §2.3 describes, not with this one. `RUNBOOK.md` Part B is
**not** obsolete: it remains the procedure for the retained `UNKNOWN_EFFECT_OUTCOME`
case, which is now the only way a barrier outlives its attempt — which is exactly
what that procedure was always for.

## What's here (Phase 5 continued — campaign signals)

ARCHITECTURE.md §9 / FROZEN_INTEGRATION.md §12 "Phase 5" is not one deliverable:
its first bullet (mixer, A/B, dispatch) shipped earlier and is documented above
under "Phase 5 — experimental planner". This is the rest of it — FROZEN_INTEGRATION.md
§5.4's `FrozenSignal.kind` table names seven values total; `PROBE_UTILITY` (a
trained model) already existed, and `ANOMALY` is explicitly out of scope ("Undefined
— only graph/state primitives exist today, no detection logic... BUILD/DEFER,
no committed mechanism", gated behind a separate Research gate, §12). Of the
remaining five, four have a real, buildable source in this repo today; the fifth
does not, and is documented as such rather than faked.

- `src/shadow/signal.ts` — `FrozenSignal.kind` widened to a named
  `FrozenSignalKind` union covering all six non-`ANOMALY` values (the schema,
  `frozen-signal.schema.json`, already allowed all seven — it was written ahead
  of this delivery).
- `src/shadow/saturation.ts` — `computeSaturation()`. §5.4: "declining marginal
  new-information rate over a window ... CampaignWorld coverage/event stats — no
  model required." Scoped per-target (not whole-campaign, so a planner decision
  can act on it): counts `RelationRecord`s touching a target whose `sequence`
  (fixed at first observation, `world/reducer.ts` never updates it) falls in the
  most recent window vs. the window before it, and reports how much that rate has
  declined. No fabricated 1.0 when there is nothing to compare against — an empty
  baseline window reports 0 with an explicit reason code instead.
- `src/shadow/target-drift.ts` — `computeTargetDrift()`. §5.4:
  "`distance(current_target_state, reference_target_state)` ... baseline,
  threshold and reason codes must be built explicitly." Aggregates two observation
  windows through the *same* `ObservationFeatureCompiler` used for training
  (mean per coordinate, `MISSING`-excluded so a sentinel never corrupts a real
  average), then reports the Euclidean distance between them plus which
  coordinate groups moved the most — real, traceable reason codes, not just a
  number. `DEFAULT_DRIFT_THRESHOLD` is a chosen operating value, documented as
  such: there is no production data yet to fit one statistically.
- `src/shadow/risk-trend.ts` — `computeRiskTrend()`. §5.4: "deterministic
  time-series aggregation of native risk scores ... CampaignWorld event history —
  no model required." Checked against real code before writing this: a
  `CampaignEvent`'s payload (`pipeline/observation-event.ts`) never carries
  `nativeMetrics` (`domain/native-metrics.ts`), so there is no event-history
  native-metric series to aggregate — this reads committed *Observations*
  instead, whose `[key: string]: unknown` index signature genuinely round-trips
  whatever an adapter attached. Splits the ordered points into two consecutive
  windows and reports the signed difference of their means — positive is risk
  increasing, negative decreasing, unlike `PROBE_UTILITY`'s implicit
  higher-is-better convention.
- `src/pipeline/grader-disagreement.ts` — `computeGraderDisagreement()`. §5.4:
  "deterministic comparison of grader verdicts on equivalent inputs — Canonical
  Correlator, not frozen." Lives in `pipeline/`, not `shadow/`, matching §5.4's
  own producer-mapping table (Canonical pipeline, not CampaignWorld or a model) —
  it still emits a `FrozenSignal` because that is the one envelope every consumer
  reads regardless of producer. Only counts *distinct engines* disagreeing on the
  same `(targetId, probeId)` — a single engine's own repeated verdicts are a
  different, uncovered phenomenon (non-determinism within one grader), and an
  UNVERIFIED/ungraded result contributes no opinion to compare, one more
  extension of `redteam.observation/unverified-data-is-not-a-positive-label`'s
  own principle.
- New laws, one per signal — `redteam.signal/saturation-value-is-bounded-and-tracks-the-windowed-rate`,
  `redteam.signal/target-drift-is-symmetric-and-zero-for-identical-windows`,
  `redteam.signal/risk-trend-direction-matches-its-own-sign`,
  `redteam.signal/grader-disagreement-is-zero-iff-graded-engines-agree` — each
  checks the real function against an independently-recomputed oracle (the exact
  windowed rate, the exact mean difference, the exact disagreement fraction), not
  the function's own formula restated. 59 laws total, 55 implemented, 4 pending
  (unchanged).
- `test/shadow/saturation.test.ts`, `test/shadow/target-drift.test.ts`,
  `test/shadow/risk-trend.test.ts`, `test/pipeline/grader-disagreement.test.ts` —
  direct unit coverage per signal, including every degenerate case each function
  handles explicitly (insufficient history, no baseline to compare against, a
  single grader, UNVERIFIED contributing nothing) and a `rtap:frozen-signal`
  schema-validity check for every signal kind.

**What's honestly not here**: `RETEST_PRIORITY` — §5.4: "deterministic
graph-weighted ranking over `GraphMessage`/episodic memory." `world/state.ts`'s
own doc comment has said since Phase 4 that episodic memory (`GraphMessage`
rings) is real infrastructure this repo has not attempted, "both real, both not
attempted here" — that has not changed, so `RETEST_PRIORITY` still has no
producer. `FrozenSignalKind` declares it (the doc's six-value F5 union is what it
specifies), and nothing computes it — a real, unmet dependency, not a build gap
in this delivery's own scope. Nothing in the planner (`planner/mixer.ts`) reads
any of the four new signal kinds yet either — same "mechanism built, nothing
wired to it in production" gap every other Phase 4.5/adapter fix in this README
has been honest about; `mixCandidates()` still only ever consumes
`PROBE_UTILITY` signals via `RankedCandidate`.

## Back-pressure is not an execution record

Second adoption from
[`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`](../wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md)
§2.2, from Arch_claude 03 §40.1's rule that a work item is not acknowledged until
responsibility for it is actually taken — and that a refusal on capacity therefore
leaves *no* record, which is precisely what makes re-offering it correct.

`admitDispatch()` created the `ExecutionAttempt` first and, when the scheduler
refused, terminalized that brand-new row as `TARGET_UNAVAILABLE`. For a
`TARGET_SERIAL` target, contention is the campaign's steady state rather than a
fault: every contested request left a durable row asserting a failed execution
against that target, carrying the same reason code as a genuinely unreachable one.
Two concrete consequences, not hypotheticals — the canonical execution journal
recorded runs that never happened, and `CampaignHistoryView`'s attempt counts (which
`enumerateEligibleCandidates()` gates eligibility on, with `maxAttemptsPerProbe: 1`
by default) were inflated by mere contention, so a probe could be ruled out for a
target it had never actually run against.

- `src/execution/dispatch.ts` — the `executionAttemptId` is minted up front with
  `randomUUID()`, and the row is written only once responsibility is genuinely
  taken. Both `ExecutionAttemptStore.start()` and `ConcurrencyScheduler.reserve()`
  already accepted an injected id, so the reservation is made with the real id it
  will be attributed to: no speculative `probe()` method, and no TOCTOU window
  between a check and the reservation.
- `DispatchGuardResult`'s `CONCURRENCY` branch is now typed `attempt: null` — the
  invariant stated in the type rather than only in a test. `TARGET_UNAVAILABLE`
  goes back to meaning what it says: a target that was actually unreachable after
  the work was claimed, not one that was merely busy. Nothing sets it today.
- **The authorization branch is deliberately not symmetric.** A denial there is a
  security event and its terminal attempt row is the only durable trace outside
  `AuditLog` — three of `evaluateAuthorization()`'s four rejection reasons are
  refused before the provider is ever consulted, so they never reach
  `AuditingAuthorizationProvider` at all. Dropping that row to make the two branches
  look alike would trade a security regression for symmetry.
- Reserving before the row exists opens exactly one new window: `start()` throws for
  a missing RunStep, which would strand the barrier. That path now releases the
  reservation before rethrowing, with its own test.
- New law `redteam.execution/backpressure-is-not-an-execution-record`, and the
  existing `dispatch-admission-composes-authorization-and-concurrency` restated to
  match. The new law checks the `execution_attempts` **row count** across N
  contested requests, not just the returned value — and it was verified to fail
  against the old behavior before being kept (`1 contested requests wrote 1
  execution_attempts rows`), rather than assumed to be meaningful. 60 laws total,
  56 implemented, 4 pending.

**What's honestly not here**: the *other* half of the same pattern is untouched.
RTAP's real claim boundary is `RunStepStore.lease()`, not `attempts.start()`, and
`lease()` increments `lease_generation` — the fencing token. A caller that leases,
then gets refused here on capacity, has already fenced out the previous attempt's
in-flight result for nothing. Fixing that needs a non-mutating `peekNext()` so
admission can run *before* the lease, and it is a caller-sequencing change with no
caller to sequence yet — it belongs with the executor `ARCH_CLAUDE_TRANSFER.md` §2.3
describes. Back-pressure also emits no metric: `OPERATIONAL_METRICS` is §11's fixed
list of seven names with no exporter behind it, so an eighth name would be both a
divergence from the doc and unobservable. The information is not lost — the refusal
returns `conflicting`, naming exactly which reservations blocked it; what was removed
is the durable false record, not the signal.

## One execution semantics for every delivery surface

Third adoption from
[`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`](../wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md)
§2.3, and the only genuinely *new* idea the whole second mining pass produced: Arch_claude
02 §19.1's observation that `query.ts` is the single source of model/tool-loop semantics
for both the interactive REPL and headless/SDK — the shells differ, the loop never does.

This repo said "sole path" three times and all three were about **commit**
(`commit-fenced-observation.ts`, `commit-observation.ts`, `index.ts`), never about
**execution**. Nothing in `src/` had ever called an adapter: the only non-test
invocation in the package was inside a law's own check. Admission, dispatch, evidence
materialization, fenced commit, settlement and step bookkeeping were composed only
inside integration tests — two of them, each in a slightly different order. ARCHITECTURE.md
§9's Phase 7 names four delivery surfaces (UI, MCP, GitLab, API) and none is written yet,
which makes now the cheap moment to fix the invariant and later the expensive one.

- `src/execution/run-step-executor.ts` — `executeLeasedStep()`: one leased RunStep in,
  one terminal outcome out. Stateless and connection-free between calls, so the
  process-level lease loop stays a thin future caller keyed by `assessmentRunId`, the
  way `RunStepStore.lease()` already is.
- **No `adapters/*` import.** Engine composition (`adapter.run()` →
  `materializeEvidence()` → `parse*()`) is a caller-supplied `StepRunner` closure. That
  keeps each adapter's `ExecFn` injection untouched, keeps the executor testable with no
  engine at all, and keeps `redteam.adapter/unsupported-capability-is-rejected` legal —
  that law instantiates `DuoLlmCliAdapter` directly, so the rule is "the executor is the
  only *production* caller of `adapters/*/run.ts`", not "the only caller anywhere". A
  test asserts the absence of that import rather than trusting review to catch it.
- **A thrown runner is not a failed effect.** `{ok: false, terminalReason}` is the
  runner classifying its own failure — it is the only party that knows whether the
  adapter was ever dispatched. An unhandled throw tells the executor nothing, and
  §7.2/§13's rule is that absence of evidence is never evidence of absence, so it
  settles `UNKNOWN_EFFECT_OUTCOME` and the barrier is retained for RUNBOOK.md Part A.
  Deliberately expensive: a runner that knows its effect never started should say
  `FAILED_BEFORE_EFFECT` and get the barrier released for free. `StepFailureReason` is a
  strict subset of `TerminalReason`, so a runner cannot report success through the
  failure channel.
- **Back-pressure does not burn the step.** A concurrency refusal returns
  `ADMISSION_REFUSED` and leaves the RunStep alone to be re-leased when its lease lapses
  — `fail()` would make transient contention permanent.
- `test/integration/executor-slice.test.ts` — a real promptfoo result travels adapter →
  evidence → parse → executor → committed Observation → CampaignEvent → outbox →
  materialized CampaignWorld, with the committed Observation carrying its
  `executionAttemptId` and its evidence ref resolving against the real `ArtifactStore`.
  This is the first place the audit #5 evidence chain runs as production code rather
  than as a unit test.
- The invariant is recorded as the twelfth row of
  [EXECUTION_SAFETY_RECOVERY.md §19](../wiki/Arch_Overlay/EXECUTION_SAFETY_RECOVERY.md)'s
  traceability table — the first addition to it since the original eleven.

**What's honestly not here.** `test/integration/vertical-slice.test.ts` was *not*
rewritten onto the executor, contrary to the transfer document's plan: it deliberately
covers the pre-4.5 `commitObservationWithEvent()` path, and converting it would delete
real coverage rather than add it. Admission still runs *after* the lease, because
`start()` copies `RunStep.leaseGeneration` and an attempt minted before the lease would
be stale the instant `lease()` incremented it — so a concurrency refusal has already
consumed a lease generation, fencing a previous attempt's late result for work this call
then declines. Bounded (that lease had already expired) but real; paying it down needs
`peekNext()` and splitting attempt creation out of `admitDispatch()`. And criterion 12
of the admission suite stays `NOT_MET`: there is no `bin/` or service loop calling
`executeLeasedStep()`, the `StepRunner` closure exists only in a test, and
`promptfooWiredToHardening` is declared evidence about a real deployment — not something
derivable from the law registry, and not something to flip because a test now exists.

## The coverage denominator: a report that can refuse

Fourth adoption from
[`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`](../wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md)
§2.4, and the deepest risk that pass found — the one place where RTAP's stated purpose
was not structurally defended.

`campaign_events` only ever contained what *succeeded*. `correlateFindings()` groups
Observations that exist; a probe that was planned and never ran produces no
Observation, therefore no group, therefore no signal anywhere. So an adapter that died
on probe 40 of 200 yielded a report that read exactly like a clean sweep of 200: 190
un-run probes were indistinguishable from 190 that ran and found nothing. For a
platform whose entire value is not fabricating security truth, that is the worst shape
a defect can take — a false *negative* presented as an assessment result.

- `src/pipeline/observation-event.ts` — `eventForScheduledProbe()`, the **first
  producer `ProbeScheduled` has ever had**. It has been sitting in
  `campaign-event.schema.json`'s closed `eventType` enum since Phase 0 with nothing
  emitting it. No schema change was needed: `sourceObservationIds: []` is legitimate
  (the field is required, `minItems` is not set, and a scheduled probe has by
  construction produced no Observation), and the payload carries no `verdict`, so the
  reducer contributes `Target`/`ProbeClass`/`PROBE_TESTS_TARGET` intent and derives no
  `Finding`.
- `src/world/state.ts` / `reducer.ts` — `CampaignWorldState.scheduledUnresolved`:
  `ProbeScheduled` adds a `(targetId, probeId)` pair, and any of the four resolving
  event types removes it. `ExecutionFailed` **resolves** on purpose — a probe that ran
  and errored is a known outcome, and conflating it with one that never ran is exactly
  the ambiguity being removed. Keyed by `targetProbeKey()`, reused rather than
  re-derived (the reducer already imports from that module, and its collision-safety
  lesson — `probeId` legitimately contains `:` — applies unchanged).
- `src/world/fingerprint.ts` — the new set is **included in the fingerprint**. Leaving
  it out would have been the quiet failure: `redteam.platform/outbox-materialization-matches-full-replay`
  compares exactly that hash, so an incremental/replay divergence in the denominator
  would have gone unnoticed by the law meant to catch precisely that.
- `src/pipeline/report.ts` — `buildJsonReport()` stays total and gains a mandatory
  `coverage` block; new `buildAssessmentReport()` returns a discriminated result that
  **refuses**: `UNRESOLVED_COVERAGE` when probes remain outstanding, and
  `UNKNOWN_COVERAGE` when no coverage information was supplied at all. Absence of
  information and proof of completeness must never look the same, so omitting coverage
  is `UNKNOWN`, never `COMPLETE`. Refusal returns the partial report rather than
  throwing — incomplete coverage is a legitimate operational state (a run still in
  flight), not a programming error, and the data stays readable.
- `src/planner/dispatch.ts` — the denominator is emitted from `dispatchDecisions()`,
  the one function allowed to create a RunStep, so it comes into existence exactly
  where a unit of work does. The `eventId` derives from the same idempotency key the
  RunStep does, so a deduped re-dispatch reuses it and `append()`'s duplicate-eventId
  idempotency collapses it: a re-dispatch can no more inflate the denominator than it
  can create a second RunStep.
- New law `redteam.artifact/coverage-denominator-is-never-assumed`, in
  `platform.laws.ts` (DB/replay style) rather than `domain-safety.laws.ts` (pure
  functions and ajv). Verified to fail against the un-tracked reducer before being
  kept — `scheduled 5, resolved 0, expected 5 outstanding but world holds 0`. 61 laws
  total, 57 implemented, 4 pending.

**Deliberately not touched**: `src/domain/verdict.ts`. A `deriveVerdict()` that
refuses on incomplete coverage would invert `frozen.laws.ts`'s asserted structural
independence of verdict derivation from worker health, and there is no
"coverage-bearing Verdict" object for it to act on. Refusal belongs in the delivery
surface, not the domain.

**What's honestly not here**: the `assessment_runs` table the transfer document's step
4 describes is not created — `assessment_run_id` remains an orphaned key on eight
tables, and `intelligence_status: DEGRADED` (specified in FROZEN_INTEGRATION.md) and
`rankCandidates().usedFallback` (computed and then discarded) still have nowhere to
live. Per-adapter `failurePolicy` (step 6) is likewise not added; when it is, it
belongs in `execution/capability-declarations.ts`, where the "declared, conservative
default, cannot be raised at runtime" convention already lives — not in
`adapters/capability.ts`, whose type is `Record<capability, boolean>` and which is a
pre-dispatch gate, not a runtime-failure handler. And `dispatchDecisions()`'s schedule
context is optional, so a caller can still dispatch without a denominator: a
`PlannerDecision` carries no reliable campaignId (only the model arm has a `binding`),
and the pre-Phase-4 planner tests genuinely have no campaign to name. A run dispatched
that way now reports `UNKNOWN` coverage rather than passing silently, which is the
intended pressure rather than a fix.

## A typed terminal, reaching the planner

Fifth adoption from
[`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`](../wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md)
§2.5. The pattern names a defect, not a technique: a system can type its terminal
outcomes carefully and still lose that precision the moment a *different* layer
reconstructs "what happened" by some other means instead of reading the typed value.

RTAP did exactly this. `CampaignHistoryView.ProbeOutcomeCounts.attempts` — the field
`enumerateEligibleCandidates()` gates retry on — was never read from
`execution_attempts.terminal_reason`. It was reconstructed by counting committed
`CampaignEvent`s. An attempt that settled `AUTHORIZATION_DENIED`, `TARGET_UNAVAILABLE`,
or `UNKNOWN_EFFECT_OUTCOME` never commits an event, so it was invisible to that count —
the planner read it as "never tried," the exact opposite of what a real, durable,
typed `TerminalReason` had already recorded two tables away.

- `src/db/migrations.ts` — migration 3, `campaign_target_identity`: nullable
  `campaign_id`/`target_id` columns on both `run_steps` and `execution_attempts`.
  Nullable because every existing caller (tests, law fixtures) has neither and keeps
  working with both simply `NULL` — only a real dispatch populates them.
- `src/runsteps/types.ts` — `RunStepPayload {campaignId, targetId, probeId}`, the
  named shape a real dispatch's payload should have. `RunStepStore.enqueue()` gains
  an optional `identity` parameter that populates the new columns;
  `ExecutionAttemptStore.start()` copies them onward from the RunStep exactly the way
  it already copies `leaseGeneration`/`attemptNo` — no caller passes them explicitly,
  same as those two fields never were either.
- `src/features/history-view.ts` — `ProbeOutcomeCounts.attempts` renamed to
  `committedOutcomes` (the name now says what it actually counts), and
  `CampaignHistoryView` gains `settledAttemptsByReason: ReadonlyMap<string,
  Record<TerminalReason, number>>`, read verbatim, never collapsed into a boolean.
  `buildHistoryView()` itself stays pure and unaware `execution_attempts` exists — it
  takes the map as an optional trailing argument, defaulting to empty, so every
  existing call site keeps working unchanged. The DB-touching half is a new sibling
  function, `buildSettledAttemptsByReason(attempts, runSteps)`: `probeId` is not a
  column on `execution_attempts` (only `campaignId`/`targetId` are), so it reads each
  settled attempt's own `RunStep.payload` back out, structurally checked against
  `RunStepPayload` — an attempt whose payload doesn't carry one is silently excluded,
  the same "not every RunStep has an identity" gap the nullable columns already
  document, not a new one.
- `src/candidates/enumerate.ts` — new `blocksEligibility(reason: TerminalReason):
  boolean`, an exhaustive `switch` with a `never` check (`execution/settle.ts`'s own
  `releasesOnSettlement()` pattern, reused deliberately — a twelfth `TerminalReason`
  will not compile here either until someone decides which side it falls on).
  `AUTHORIZATION_DENIED`/`CAPABILITY_UNSUPPORTED`/`UNKNOWN_EFFECT_OUTCOME` block;
  everything else — including `TARGET_UNAVAILABLE`, ordinary resource contention and
  RTAP's own steady state for a `TARGET_SERIAL` target — does not.
  `enumerateEligibleCandidates()` now excludes a probe with **zero** committed
  outcomes if its settled attempts name a blocking reason, closing the gap directly:
  a probe that was never actually attempted (only ever refused) no longer reads as
  eligible-by-omission, and a probe that was merely contended-for no longer reads as
  permanently exhausted.
- Honestly short of the transfer document's own stated nuance: it describes
  `AUTHORIZATION_DENIED` as blocking "until policy version changes" and
  `UNKNOWN_EFFECT_OUTCOME` as blocking "without an explicit operator decision."
  Neither mechanism — a policy-version comparison, an operator-decision record —
  exists anywhere in this repo, so both simplify to "always blocks" rather than
  pretending a conditional reinstatement this codebase cannot yet evaluate.
- New law `redteam.execution/settled-attempt-is-not-an-unattempted-candidate`, DB
  style in `platform.laws.ts`: across every `TerminalReason`, a real
  `RunStepStore` → `ExecutionAttemptStore` → `buildSettledAttemptsByReason()` →
  `buildHistoryView()` → `enumerateEligibleCandidates()` pipeline agrees exactly with
  `blocksEligibility()`'s own verdict — end to end, not just the pure function in
  isolation — and never leaks across an unrelated target. 62 laws total, 58
  implemented, 4 pending.
- `test/runsteps.test.ts`, `test/execution/execution-attempt-store.test.ts`,
  `test/features/history-view.test.ts`, `test/candidates/enumerate.test.ts` — direct
  unit coverage per layer, including the exact bug this closes (a `TARGET_UNAVAILABLE`
  settled attempt must not exclude the probe) and the exact regression the naive
  version would have caused (a real, working `AUTHORIZATION_DENIED`/
  `UNKNOWN_EFFECT_OUTCOME` exclusion with zero committed outcomes).

**Key, per the transfer document itself**: `campaign_events` is not touched at all —
no connection to gap 7, no dependency on the open ADR, no schema-version history for
terminal reasons to manage.

**What's honestly not here**: `assessment_runs` still does not exist (the coverage
denominator work above left the same gap), so there is no real durable place a future
policy-version comparison or operator-decision record for the two "until X" refinements
above would live yet. `probeId` is deliberately not promoted to its own column on
`execution_attempts` — reading it back through the RunStep's payload was the smaller,
more honest change given the migration's own stated scope (two columns, not three).

## Pruning delivered outbox rows

Sixth and last adoption from
[`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`](../wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md)
§2.6 — the document's own honest self-assessment: "the weakest item on the list." The
source pattern (a compaction boundary that is simultaneously a runtime transition and
a persistence marker) doesn't transfer here; what remains is a real, if small, defect
this repo genuinely had — there was no `DELETE FROM` anywhere in `src/`, and `outbox`
grew monotonically forever.

- `src/events/outbox.ts` — `OutboxStore.pruneDelivered(campaignId, throughSequence)`:
  `DELETE FROM outbox WHERE campaign_id = @campaignId AND delivered_at IS NOT NULL AND
  sequence <= @throughSequence`. This is a safety guarantee, not an optimization —
  `listUndelivered()` already filters on exactly `delivered_at IS NULL`, so a row this
  predicate could ever touch was already invisible to every real reader; deleting it
  changes nothing any caller could observe.
- `src/world/materializer.ts` — `CampaignWorldMaterializer.pruneDeliveredOutbox(campaignId)`.
  The watermark is deliberately not a new column or table: it *is*
  `materialized_worlds.last_sequence`, the exact cursor `advance()` itself already
  trusts, so pruning can never race ahead of what has genuinely been materialized. A
  campaign with no persisted world yet (`current()` is `null`) has no safe watermark
  and is left untouched — pruned to `-Infinity` would have been the actual bug this
  design avoids.
- No new law — the plan's own instruction, followed literally: the existing
  `redteam.platform/outbox-materialization-matches-full-replay` already commits real
  events, advances a real materializer, and compares against `replay()`'s fingerprint;
  `pruneDeliveredOutbox()` is now called on roughly two of every three simulated
  crash-and-restart chunks, and every row at or before the watermark is asserted gone
  from the outbox afterward, in the same run that already proves the fingerprint
  still matches full replay. 62 laws total, 58 implemented, 4 pending (unchanged).
- `test/events/outbox.test.ts`, `test/world/materializer.test.ts` — direct unit
  coverage: exactly the delivered rows at or before the watermark are removed, an
  undelivered row is never touched regardless of watermark, pruning with no
  materialized world yet is a safe no-op, and — the one that actually matters
  operationally — pruning does not disturb resumption: a later `advance()` still
  reaches the same fingerprint as a full replay after rows it no longer needs have
  been deleted out from under it.

**Deliberately not in this commit**, per the transfer document's own instruction:
bounding `appliedEventIds` — persisted whole and re-serialized on every `advance()`
(`materializer.ts`'s own `serialize()`) — is unbounded growth of a different, larger
kind than the outbox ever was, and is not one of the fourteen originally declared
gaps. Left as a separate, later concern, not folded in here to pad out this fix.

## Deterministic precedence order, not just precedence outcome

First adoption from the *other* `wiki/Arch_claude/` mining pass — not
`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md`'s adversarial one (§2.1–2.6, all six now
closed), but the earlier value-lens pass that graded each idea on its own engineering
weight before checking resonance against this repo. Its own resonance check, re-run
against the current codebase, reconfirmed one specific residual gap in an idea it had
otherwise already found implemented: `evaluateAuthorization()`'s fail-closed
V→C→P→S order was real code, but nothing had ever proven *which* reason wins when
more than one stage fails at once.

- `src/laws/catalog/execution-safety.laws.ts` —
  `redteam.execution/authorization-precedes-effect` now independently derives the
  expected winning `AuthorizationRejectionReason` via a new `expectedAuthorizationReason()`
  oracle — a plain V→C→P→S priority-reducer, written from scratch rather than by reading
  `evaluateAuthorization()`'s own `if`-chain — and asserts `result.reason` matches it
  exactly on every denied trial, not only that `authorized` came out `false`. The trial
  also now randomizes a genuinely malformed request (one of the eight required fields —
  `campaignId` through `policyRevision`, including both halves of `adapterIdentity` —
  blanked at random) combined independently with digest/policy/sandbox/egress failures,
  so `MALFORMED_REQUEST` is proven to win even against a request that would also fail
  every stage after it.
- No change to `evaluateAuthorization()` itself. The gap was entirely in what the law
  proved, not in what the code did — the sequential `if`-chain already implemented the
  correct precedence; nothing before this trial had ever exercised it under combined,
  simultaneous stage failure.
- No new law, same convention already used for §2.6: extends an existing one. 62 laws
  total, 58 implemented, 4 pending (unchanged).

**What's honestly not here**: the second half of the idea's own framing — decomposing
the V/C/P/S checks into independently-testable oracles composed by one small,
first-class priority-reducer, rather than a sequential `if`-chain whose order is only
implicit in source-code position — is not attempted here. This proves the current
implementation's precedence is correct; it doesn't restructure it into a form where that
precedence is itself a named, inspectable value.

## Concurrency-safety is a promise, not a proof

Second adoption from the diamonds' "Дальше по очереди" queue — грань №7. Doc-comments
only, no logic changed: a green `redteam.execution/unknown-concurrency-is-exclusive`
already proved the scheduler enforces whatever `ConcurrencyClass` it is handed
correctly; nothing said out loud that the class itself is never verified against the
adapter it is supposedly describing.

- `src/execution/concurrency.ts` — `ConcurrencyDeclaration`'s own doc comment now
  states the caveat precisely, and precisely means the *current* code, not a
  hypothetical: unlike `EngineAdapterCapabilities` (`adapters/capability.ts`), which
  is a property each adapter registers and that authorization checks before dispatch,
  a `ConcurrencyDeclaration` has no adapter-side registry at all — it is whatever
  value the caller of `admitDispatch()`/`ConcurrencyScheduler.reserve()` happens to
  pass in. The resonance refresh that surfaced this (`Грани Arch_claude`, грань №7)
  caught the original transfer-document framing being imprecise on exactly this
  point — it isn't the adapter's promise, it's the caller's.
- `src/execution/concurrency-scheduler.ts` — a short cross-reference on the class's
  own doc comment, pointing at `ConcurrencyDeclaration` rather than restating the
  caveat, so it doesn't drift out of sync with it later.
- No test changes — nothing observable changed. `git diff --stat` on this commit is
  comments only.

## Interceptor plan wiring: deferred, not forgotten

Third item from the diamonds' queue — грань №10, the one the roadmap flagged as
needing "a decision, not just an audit." The decision: **don't wire `compilePlan()`
into the real dispatch loop yet.** Doc-comment fix only; no production behavior
changed.

- The premise turned out to still be true after checking, not just plausible: `grep`
  across `src/` for `InterceptorDescriptor`/`compilePlan`/`evaluateStageOutcomes`
  outside `interceptor.ts` itself and the law catalog finds nothing. Zero concrete
  interceptors — `PRE_DISPATCH`, `POST_NATIVE_RESULT`, or any other stage — exist
  anywhere in this repo. `compilePlan()` is real, tested, and deterministic
  (`redteam.execution/interceptor-order-is-deterministic`); it has just never been
  asked to compile anything but synthetic descriptors a law test constructed.
- Given that, wiring it into `executeLeasedStep()` today would mean calling
  `compilePlan(planGeneration, policySnapshotRef, [])` on every real dispatch — an
  always-empty list. `ExecutionAttempt.interceptorPlanGeneration` would flip from an
  honest `null` to a real-looking, non-null number that gates nothing, because
  `evaluateStageOutcomes()` — the half that actually enforces
  `SECURITY_CRITICAL`/`ADVISORY` outcomes — still has no call site anywhere in the
  real executor to feed it real outcomes from. That's strictly worse than the
  current honest `null`: a populated field with no interceptor behind it reads as
  "this attempt went through interceptor review" to anything downstream (reports,
  provenance) that doesn't know better.
- `src/execution/types.ts` — `StartAttemptInput.interceptorPlanGeneration`'s doc
  comment corrected. It used to say `null` because "4.5.4's compilePlan() ... not
  wired into a dispatch loop, since none exists" — stale since §2.1–2.3 built a real
  one. Now states the actual, current reason: no concrete interceptors exist to
  compile, so wiring the mechanism now would be cosmetic completion, not real
  enforcement — deliberately deferred, not an oversight the comment was hiding.
- No test changes, no law changes, no other file touched.

**What would actually unblock this**: at least one real `InterceptorDescriptor` with
a genuine implementation behind it (even one `ADVISORY`, `TELEMETRY_ONLY` interceptor
at `PRE_DISPATCH` would do) — at that point `compilePlan()` has something non-trivial
to compile, `evaluateStageOutcomes()` has real outcomes to check, and wiring both into
`executeLeasedStep()` becomes a mechanism actually doing something, not a field being
populated to satisfy a type.

## A production caller for the Promptfoo vertical slice

§15 criterion 12 — "All Architecture Laws pass for the Promptfoo vertical slice" —
was honestly `NOT_MET` since `executeLeasedStep()`'s only caller anywhere was a test
(`test/integration/executor-slice.test.ts`). `execution/run-step-executor.ts`'s own
doc comment names the fix: "the process-level lease loop stays a thin caller (a
future `bin/`)." This is that caller, promptfoo-specific per criterion 12's own
"vertical slice" framing — not a generic multi-engine dispatcher, which nothing here
asked for.

- `src/worker/promptfoo-worker.ts` — the testable composition. `buildDispatchRequest()`
  derives a `DispatchGuardRequest` from one leased `RunStep` plus a fixed
  `PromptfooWorkerConfig` (the deployment policy no `RunStepPayload` carries —
  principal, capability digest, sandbox/egress refs — the same fields
  `executor-slice.test.ts` hardcoded per call, now fixed once per worker process).
  `buildPromptfooStepRunner()` is the `StepRunner` closure `run-step-executor.ts`
  asks a real `bin/` to build: `PromptfooCliAdapter` → `parsePromptfooResult()` →
  `materializePromptfooEvidence()` → `eventForObservation()`, defaulting to a real
  adapter (real `execFile`/`readFile`) rather than the fixture injection tests use.
  `runPromptfooWorkerOnce()` leases every currently-leasable `RunStep` for one
  assessment run in turn and drives each through `executeLeasedStep()`, until
  `lease()` returns null — drains the queue once rather than polling forever; a
  daemon wrapper is a thin loop around calling this on an interval, not built here,
  since §15 doesn't ask for one and a poll loop needs its own testing this change
  doesn't need to take on.
- One promptfoo invocation is assumed to answer exactly one `RunStep` — a config
  scoped to a single probe/target, not a batch. `results.length !== 1` is refused as
  `NORMALIZATION_FAILED` rather than guessed at (`results[0]`), since nothing in this
  repo maps a promptfoo result index back to a specific `RunStep`.
- A leased step with no `campaignId`/`targetId` (every pre-§2.5 caller, or a bug) is
  refused before a `DispatchGuardRequest` can even be built — `admitDispatch()` was
  never going to see it. `MALFORMED_STEP` durably fails the `RunStep` with a clear
  reason rather than throwing or silently skipping it.
- `src/worker/cli.ts` — the actual, real, non-test entry point:
  `tsx src/worker/cli.ts --db=... --assessment-run-id=... --config=...` (also
  `npm run worker:promptfoo --`). Opens a real file-backed database via
  `openDatabase()` (migrations included), validates the JSON config file's required
  fields fail-closed before touching anything, and calls `runPromptfooWorkerOnce()`
  with no adapter override — genuinely real `PromptfooCliAdapter`. Smoke-tested by
  hand against a real SQLite file: an empty queue exits `0` cleanly; a real leased
  step reaches an actual `execFile('promptfoo', ...)` call (which fails cleanly, as
  expected, since no `promptfoo` binary exists in this environment — and that failure
  is exactly what proves the wiring is real, not mocked) and is durably recorded as
  `FAILED`, not lost.
- `test/worker/promptfoo-worker.test.ts` — the composition module tested the same way
  `executor-slice.test.ts` tests `executeLeasedStep()` directly: a fixture-injected
  `PromptfooCliAdapter`, a real in-memory database, real stores. Covers a committed
  step, two steps drained in one call (with the collision a naive reuse of one native
  result across two targets would cause — a real bug the test writing itself caught,
  fixed by sequencing distinct fixture outputs), the `MALFORMED_STEP` refusal, the
  `results.length !== 1` refusal, and an empty queue.
- `src/execution/admission.ts` — `CURRENT_EXTRA_EVIDENCE.promptfooWiredToHardening`
  flips to `true`; criterion 12's `detail` now names the real files instead of their
  absence. Criterion 2 ("every Observation binds an active ExecutionAttempt") also
  flips to `MET` as a direct consequence — it was always gated on this same flag, not
  a separate one. §15 admissibility overall is still honestly `false`: criterion 14
  (the hardening feature flag / rollback drill) remains `NOT_MET`, untouched by this
  change.

**What's honestly not here**: a long-running daemon/poll loop, retry/backoff policy
for a worker process that crashes mid-drain (the durable lease/RunStep state already
survives that — a restarted worker just re-leases what an expired lease frees, same
guarantee `test/execution/crash-kill-points.test.ts` already covers at the mechanism
level), and any engine other than promptfoo. None of the three were asked for by §15
criterion 12, which names the promptfoo slice specifically.

## Evidence levels: Observed / Inferred / Missing

грань №11 (`Грани Arch_claude`) — a documentation discipline, not a mechanism: grade
every non-trivial claim in a doc comment or report by how it's actually known,
instead of a binary documented/undocumented split.

- **Observed** — checked directly: a test ran, a `grep` was performed and its output
  read, a fixture's shape was hand-verified against the real system it stands in for.
- **Inferred** — a reasoned conclusion from Observed facts, not itself independently
  checked (e.g. "duo-agents' own gate would still block this even if fixed" — reasoned
  from the gate's stated design, not observed against a real gate).
- **Missing** — explicitly named as unknown, not silently absent. The distinguishing
  move is saying *why* it's missing, not only that it is.

Two real precedents already existed in code before this vocabulary was named — it
formalizes an ethos this repo already practiced, not a new one:

- `laws/types.ts`'s `LawStatus = 'implemented' | 'pending'` — `'implemented'` (held or
  failed) is Observed: a property test actually ran and produced a verdict, positive
  or negative. `'pending'` is Missing, and `pendingReason` is required exactly because
  (the type's own comment, unchanged here) "an unstated pending law is
  indistinguishable from a forgotten one."
- `pipeline/report.ts`'s `CoverageStatus = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN'` —
  `COMPLETE`/`INCOMPLETE` are Observed (every scheduled probe's resolution was
  actually checked), `UNKNOWN` is Missing (no coverage data was even supplied) — that
  type's own comment: "Absence of coverage information and proof of full coverage
  must never look the same."

Applied for real, not just defined, in two places:

- `src/laws/cli.ts` now prints one legend line naming the correspondence on every
  report it emits, not only here.
- The three engine adapters' top-level doc comments
  (`adapters/{promptfoo,duo-llm,duo-static}/run.ts`) each end with an explicit
  "Evidence grade" paragraph — grading claims the prose already made, not adding new
  ones. These are the concrete case грань №11's own text names: "особенно для
  контрактов адаптеров."

**What's honestly not here**: no new field, type, or law-registry mechanism. This is
a prose convention applied where it was asked for — it does not retrofit every doc
comment in the repo, and does not force `Law.status`/`CoverageStatus` into a shared
three-level enum. Their existing two/three-value types already carry the distinction
that matters for each; a shared type would flatten a real difference between what a
law verdict and a coverage count each actually mean.

## Ask as suspended continuation: still not applicable, checked again

грань №12 — checked before writing this, not assumed: `grep` across `src/authz/`,
`execution/authorization.ts`, and `execution/dispatch.ts` for
`ask`/`pending`/`suspended`/`HITL`/`human-in-the-loop` finds nothing.
`AuthorizationDecision` (`authz/types.ts`) remains exactly `{ allowed: boolean;
reason: string }` — no third state — and `AuthorizationProvider.authorize()` is
synchronous by signature, not `Promise`-returning, so the type itself resists a
mid-call suspension without a breaking change, not just an unwritten feature.

No source change accompanies this entry — unlike грань №10, there is no existing
scaffolding here to correct or point at (no half-wired suspended value, no unused
field carrying the shape of a future state). Writing one from scratch would mean
inventing infrastructure for a caller that doesn't exist: `evaluateAuthorization()`'s
V→C→P→S pipeline is synchronous and complete by design, every stage passing or
failing closed immediately, with no branch that would ever need to pause and wait.

**Not the same thing, despite the surface resemblance**: `RUNBOOK.md` Parts A/B
already describe a human stepping in — resolving an `UNKNOWN_EFFECT_OUTCOME` (Part A),
releasing a retained `ConcurrencyReservation` (Part B). Both are reactive: an operator
fixes an already-occurred ambiguous state, outside any request's own call stack,
possibly hours later. грань №12's idea is proactive: an authorization decision itself
becomes a suspended `Promise` sitting at the exact point of execution, and something —
a human, a timeout, a competing resolver — must claim it exactly once before any side
effect happens. Naming both "human in the loop" would force a resonance the idea's own
text never claims.

**What would actually make this real**: a call site that needs to pause mid-authorization
and wait — an `AuthorizationDecision` third state (`ask`, carrying a resolvable
handle), a resolver that claims it exactly once before producing any side effect, and
a Phase 4.5 gate willing to hold an `ExecutionAttempt` in a non-terminal, non-committed
state while it waits. None of the three exist, and building any one without the other
two would be inert.

## Identity manifest vs. watermark: a pure-function library, not a wired mechanism

грань №14 — re-checked directly, not from memory. `grep` for every caller of
`snapshotWorld()`/`verifySnapshot()`/`WorldSnapshot` outside `world/snapshot.ts` itself
finds exactly three: one law
(`redteam.world/snapshot-digest-detects-tampering`), one dedicated unit test, and one
doc-comment cross-reference in `materializer.ts` — prose only, no function call. No
`world_snapshots` table exists in `migrations.ts`; no `SnapshotStore` class exists
anywhere. This is sharper than the earlier resonance-refresh's phrasing ("уже есть
неподключённый строительный блок") suggested: it isn't a block sitting ready to be
plugged in, because there is nowhere durable for it to live yet —
`snapshotWorld()`/`verifySnapshot()` are pure, in-memory functions, proven correct in
isolation by a property law, with no persistence layer behind them at all.

`CampaignWorldMaterializer.current()` (read directly to confirm) is exactly the pure
watermark cache the idea warns against: `deserialize(row.state_json)` calls
`JSON.parse()` with no digest check and no `try`/`catch` — a corrupted `state_json` row
throws straight out of `current()` (and therefore `advance()`), instead of triggering a
rebuild via `replay()`. §2.6's `pruneDeliveredOutbox()` deepened the dependency on this
same watermark (`materialized_worlds.last_sequence`) without adding any integrity check
alongside it.

**Not built here, and more deliberately scoped out than грань №10 was**: unlike
`compilePlan()`/`interceptorPlanGeneration` (a complete mechanism missing only a
caller), closing this gap for real means designing and building three new things at
once — a persistence table for `WorldSnapshot` rows, a policy for when a snapshot is
taken (every `advance()`? every N events? on a schedule?), and corrupted-cache-triggers-
rebuild logic in `current()` itself. None of the three exist, and inventing all three
now, with no reported corruption incident and no caller asking for it, would be
building infrastructure this repo's own engineering discipline argues against —
designing for a hypothetical failure mode, not a concrete one.

**What would actually make this real**: a specific decision about snapshot cadence (the
one genuinely open design question — everything else is close to boilerplate once
that's answered), a `world_snapshots` table, and `current()` falling back to `replay()`
when `verifySnapshot()` disagrees with a stored row, instead of throwing.

## Approval vs. per-operation scoping: the gap is now self-referential

грань №15 — re-checked directly, and the evidence is sharper than at the last
resonance refresh for a concrete reason: this repo now has a real production caller
to point at (`src/worker/`), not only test-exercised adapter code.

`defaultExec()` — the real, non-injected path every engine adapter's `run.ts` uses —
calls `execFileAsync(bin, args, { cwd, maxBuffer })`. No `env`, `uid`, `gid`, or
resource-limit option is passed; the child process inherits the worker's full
environment and privileges. `grep` for every reference to `sandboxProfileRef`/
`egressPolicyRef` across `src/` confirms what the earlier finding said and adds one
more data point: `execution/authorization.ts` checks only that both are non-null
(fail-closed on absence, `SANDBOX_OR_EGRESS_POLICY_MISSING`) and
`authorization-receipt-store.ts` persists them — neither reads them to actually
narrow anything. `src/worker/promptfoo-worker.ts`, built for §15 criterion 12, is now
the concrete, self-referential example: `PromptfooWorkerConfig` requires both fields
(`cli.ts`'s own fail-closed validation rejects a config missing either), they flow
into every `AuthorizationReceipt` this worker issues, and then go nowhere near the
`PromptfooCliAdapter()` call that actually spawns the process. The gate this worker
enforces is exactly the coarse one грань №15 describes: finer than one approval for
the whole process (a fresh `AuthorizationReceipt` per `RunStep`), but the child
process it dispatches inherits unscoped rights regardless.

**Not built here**: real sandboxing (dropped privileges, a scrubbed environment,
seccomp, a container boundary — any of the concrete mechanisms `sandboxProfileRef`
implies) is a substantial security feature nothing has asked for yet, and building
one speculatively, disconnected from an actual sandbox technology decision, would be
worse than not building it — a narrowing mechanism nobody chose the shape of.

**What would actually make this real**: a decision about which sandboxing mechanism
`sandboxProfileRef` is meant to name (the ref is currently opaque — a string with no
resolver), and `defaultExec()` (or a new wrapper around it) actually applying
whatever that mechanism resolves to before `execFile` runs, not just recording that a
profile was declared.

## Wide read projection vs. narrow aggregate: first audit pass

грань №9 is explicitly not a one-off task — "recurring · не разовая задача." This is
the first dated pass, not a final answer to a question that stays open: has any
read-side structure quietly started enforcing write-side validation that belongs only
to the event log or a narrow aggregate store?

Checked directly, file by file — every module that reads across many records to
answer a question, rather than owning one record's lifecycle:

- `features/history-view.ts` — `buildHistoryView()`/`buildSettledAttemptsByReason()`.
  Pure counting/aggregation only; nothing here rejects or blocks anything, both read
  verbatim from already-committed data.
- `world/state.ts` + `world/reducer.ts` — `applyEvent()` does reject
  (wrong-campaign, sequence-gap, illegal-relation), but this is legitimately the
  world graph's own aggregate boundary, not a projection borrowing someone else's
  rule: `graph-schema.ts` declares the legal relation types this enforces, and
  dedicated laws (`event-gap-is-rejected`, `replaying-the-same-events-produce-same-state`)
  hold it to exactly that job.
- `execution/concurrency-scheduler.ts`'s `activeReservations()`/
  `activeReservationForAttempt()` — pure read queries. One worth flagging by name:
  `activeReservationForAttempt()` throws if it finds more than one active reservation
  for an attempt. Reviewed and judged legitimate, not a violation — a defensive
  assertion on data it just read (`reserve()` is the actual enforcement point, called
  exactly once per admission by `admitDispatch()`'s own calling convention), not a
  read path independently deciding whether a reservation is allowed to exist.
- `candidates/enumerate.ts`'s `enumerateEligibleCandidates()` — filters candidates via
  `blocksEligibility()` and coverage-derived exclusions. Its own doc comment already
  states the exact boundary this audit exists to check: "no I/O, no RunStep access, so
  this alone cannot influence execution — enumeration is not dispatch." Confirmed:
  `evaluateAuthorization()`/`admitDispatch()` remain the only real dispatch gate,
  entirely independent of this function — a bug here wastes a redundant attempt, it
  does not open a safety hole.
- `pipeline/report.ts`'s `buildAssessmentReport()` — its `ok: false` branches decide
  report *presentability*, not whether an operation may happen; no domain invariant
  duplicated here belongs anywhere else.
- `planner/mixer.ts`'s `mixCandidates()` — pure ranking over already-filtered
  candidates, no rejection logic at all.

**Result: no violation found.** Followed by a repo-wide `grep` for
`throw`/`ok: false`/`valid: false` across every read-side directory (`features/`,
`candidates/`, `pipeline/`, `world/`) to catch anything the file-by-file pass missed —
nothing outside what's listed above.

**Because this is recurring, not closed**: the next real trigger for re-running this
check is adding a new read-side module to any of these four directories, or extending
an existing one with new filtering/rejection logic — not a calendar date.

## A durable home for WorldSnapshot: грань №14, actually built

The one backlog item where "what would actually make this real" turned out to be
tractable enough to just do: `world/snapshot.ts`'s `snapshotWorld()`/`verifySnapshot()`
were proven-correct pure functions with nowhere durable to live. Now they do, and
`CampaignWorldMaterializer.current()` uses them for real — a corrupted
`materialized_worlds.state_json` row falls back to a full `replay()` instead of
throwing or silently returning wrong data, closing the exact gap the README's earlier
"pure watermark cache" finding named.

- `src/db/migrations.ts` — migration 4, `world_snapshots`: one row per campaign,
  upserted, matching `materialized_worlds`'s own "latest state only" convention
  exactly. No historical retention — nothing has asked for one, and `replay()` can
  always reconstruct any point from the canonical event log regardless of what this
  table holds.
- `src/world/snapshot-store.ts` — `SnapshotStore`, a thin `save()`/`get()` pair over
  that table, the same constructor-injection shape every other store in this repo
  uses.
- `src/world/materializer.ts` — `CampaignWorldMaterializer` gained a `snapshots`
  constructor parameter (optional, defaults to a real `SnapshotStore`, same pattern
  `outbox` already used). `advance()` now takes a snapshot in the same transaction as
  the `materialized_worlds` write, but only when `eventsApplied > 0` — an unchanged
  world's existing snapshot already describes it exactly, so skipping is correctness,
  not laziness. `current()` now verifies the deserialized world against that snapshot
  (`verifySnapshot()`) and, on `JSON.parse()` failure or a mismatch, falls back to
  `replay(events.listByCampaign(campaignId), campaignId).world` instead of throwing —
  the fix the earlier finding said was missing, word for word.
- The self-healing is free, not a separate mechanism: `advance()` calls `current()`
  internally to find its starting point, so the next real `advance()` after a
  corruption event persists a fresh, correct `materialized_worlds` row and snapshot as
  a side effect of its normal write path — no dedicated repair code needed.
- `src/laws/catalog/platform.laws.ts` —
  `redteam.world/corrupted-cache-falls-back-to-replay`: commits a random event stream,
  materializes it, randomly corrupts `state_json` (invalid JSON, a tampered field the
  snapshot disagrees with, or not at all), and asserts `current()` never throws and
  always fingerprints identically to a full replay regardless of which. 63 laws total,
  59 implemented (up from 62/58) — a new law, not an extension, since this tests a
  qualitatively different property (behavior under corruption) than
  `outbox-materialization-matches-full-replay` (steady-state correctness) already did.
- `test/world/snapshot-store.test.ts`, `test/world/materializer.test.ts` — direct unit
  coverage: a snapshot round-trips exactly, upserts rather than accumulates, a
  no-op `advance()` leaves an already-correct snapshot byte-for-byte untouched (not
  merely equal in value), and both corruption shapes recover to the same fingerprint
  a full replay produces.

**What's honestly not here**: `snapshotWorld()`'s `modelSnapshotRef`/`worldBinding`
context is always `null` from the materializer — it has no access to either concept
(`domain/recommendation-binding.ts`'s territory, not this module's), so only a future
Phase 5 caller with real values to supply would populate them for real. The one design
decision this README earlier called genuinely open — snapshot cadence — was resolved
with the simplest defensible default (every `advance()` that changes anything), not a
configurable policy; nothing has asked for a different cadence yet, and the two-line
`if (eventsApplied > 0)` is trivial to revisit if one is ever needed.

## §15 criterion 14: the rollback drill, and full Phase 5 admissibility

**`evaluatePhase5Admission()` now reports all fourteen criteria MET.** This is the
first time in this repo's history that `report.admissible` is honestly `true` — not
because the bar moved, but because criterion 14, the last one standing, now has a
real mechanism and a real law behind it instead of a declared `false`.

Criterion 14's own text: "a rollback drill proves disabling the hardening feature flag
does not weaken fencing of already-started attempts." The literal wording is generic —
"hardening feature flag" names no specific mechanism — so the real work here was
picking *which* of the 4.5.1-4.5.4 mechanisms a flag could safely gate, without
building an actual security bypass into a shipped code path. The answer: gate
authorization only, because fencing is structurally incapable of being affected by
anything `admitDispatch()` does — `execution-attempt-store.ts`'s `bindNativeResult()`
doesn't take a hardening parameter at all, so there is no code path by which disabling
one could reach the other. Concurrency reservation stays unconditional too; only
`evaluateAuthorization()` is skippable.

- `src/execution/dispatch.ts` — `HardeningConfig { authorizationEnforced: boolean }`
  and `HARDENING_ENFORCED = { authorizationEnforced: true }`. `admitDispatch()` gained
  an optional, trailing `hardening` parameter defaulting to `HARDENING_ENFORCED` — every
  existing caller (the whole test suite, `worker/`, every other law) keeps calling it
  exactly as before and gets exactly the old behavior. `DispatchGuardResult`'s
  `authorizationReceipt` is now `AuthorizationReceipt | null` — `null` only when
  bypassed, honestly reflecting that no decision was made to attach a receipt to,
  never a fabricated one. Nothing in `worker/` or any production path ever constructs
  a disabled `HardeningConfig` — this exists to make the property provable, not to
  give an operator a working bypass switch.
- `src/laws/catalog/execution-safety.laws.ts` —
  `redteam.execution/rollback-disables-authorization-not-fencing` (200 trials), proving
  both halves in one law: (1) bypass genuinely disables authorization — a request
  denied under `HARDENING_ENFORCED` for either a role-based or cross-tenant reason is
  admitted when bypassed, with a `null` receipt, not a rubber-stamped one; (2) fencing
  is byte-for-byte identical regardless of which mode admitted the attempt — a
  bypass-admitted attempt is rejected `STALE_LEASE_RESULT` once its lease is
  superseded, exactly as an enforced-admitted one would be. 64 laws total, 60
  implemented (up from 63/59).
- `src/execution/admission.ts` — criterion 14 moved from a declared
  `extraEvidence.hardeningFeatureFlagExists` boolean to `lawCriterion()`, the same
  derivation every other law-checkable criterion already used. `AdmissionExtraEvidence`
  loses that field entirely — there is nothing left to honestly declare once a real
  law can check it.
- `test/execution/dispatch.test.ts` — four focused unit tests complementing the
  property law: `HARDENING_ENFORCED` behaves identically to omitting the parameter,
  bypass admits a `VIEWER` `HARDENING_ENFORCED` would deny, bypass still contends for
  the concurrency barrier (only authorization is skipped, not the whole gate), and
  fencing rejects a stale result from a bypass-admitted attempt.
- `test/integration/interceptor-and-envelope-slice.test.ts` — a Phase 4.5.4-era test
  asserted `report.admissible === false` as a point-in-time fact; fixed to check only
  what it was actually testing (the law-backed criteria available at that phase),
  since pinning the overall verdict to a state this repo was always working to change
  was never really the intent.

**What's honestly not here**: no operator-facing way to actually flip this flag in
production — no CLI arg, no config field, no env var. That is deliberate: the honest
scope of criterion 14 is "prove the property," not "ship a rollback control," and
building the latter without a real operational reason would be exactly the kind of
speculative surface this README has argued against for грань №12 and №15. If a real
rollback scenario is ever needed, `HardeningConfig` is already the seam to thread one
through — `worker/promptfoo-worker.ts`'s config would need one new optional field.

## грань №15: privilege/env scoping, the mechanism actually picked

The gap was concrete, not speculative: `defaultExec()` in every adapter's `run.ts`
called `execFile(bin, args, { cwd, maxBuffer })` — no `env`, no `uid`/`gid` — so a
spawned child process inherited this worker's *entire* environment and privileges.
Three real mechanisms were on the table (privilege/env scoping via
`node:child_process`'s own options; a container runtime; Linux seccomp/namespaces);
the first won because the other two each add a hard new dependency this project
doesn't otherwise have — a container runtime, or a Linux-only, unbuildable-on-this-
dev-machine syscall layer — for a repo whose entire dependency list today is `ajv`.

- `src/execution/sandbox.ts` — `SandboxProfile { env, uid?, gid? }`,
  `minimalSandboxProfile()` (PATH only — the honest minimum a binary needs to be
  *found* at all, never full inheritance), and `scopedExecOptions()`, the pure
  function every adapter's `defaultExec()` now delegates to. No `sandbox` given
  defaults to `minimalSandboxProfile()`, not to `execFile()`'s own default (inherit
  everything) — the safe behavior is what an adapter author gets for free, not
  something they have to remember to opt into.
- `src/adapters/{promptfoo,duo-llm,duo-static}/run.ts` — all three updated
  identically (matching this repo's own established practice of independent,
  non-shared adapter code — грань №6's own resonance: "each engine architecturally
  isolated, no shared parsing code"). `ExecFn`'s `opts` gains `sandbox?: SandboxProfile`;
  `defaultExec()` calls `scopedExecOptions()`; each `*RunOptions` interface gains a
  `sandbox?: SandboxProfile` field threaded to `execFn`.
- `src/worker/promptfoo-worker.ts` — `PromptfooWorkerConfig` gains `sandbox?:
  SandboxProfile`, distinct from the pre-existing `sandboxProfileRef` (which stays
  exactly what it always was — an opaque identifier recorded on the
  `AuthorizationReceipt`, still not read for enforcement; that gap is criterion 8's
  territory, not this one's). `runPromptfooWorkerOnce()` merges it into the options
  passed to `adapter.run()`. `src/worker/cli.ts` validates its shape (an object of
  string `env` values, numeric `uid`/`gid` if present) before use, fail-closed like
  every other config field.
- `test/execution/sandbox.test.ts` — seven unit tests on the pure functions:
  `minimalSandboxProfile()` carries only `PATH`, `scopedExecOptions()` defaults
  correctly, threads an explicit profile's `env`/`uid`/`gid` through, and omits
  `uid`/`gid`/`cwd` keys entirely when unset (matching `exactOptionalPropertyTypes`,
  not just passing `undefined` through).
- Hand-verified against a real spawned process, outside the test suite: a child
  given `env: { PATH }` genuinely cannot see a `SECRET_VAR` set in the parent
  process's environment (`SECRET_VAR in childEnv` is `false`, checked by parsing the
  child's own `process.env` dump) — this is what actually proves the mechanism works,
  not just that the pure option-builder returns the right object shape. `uid`/`gid`
  were confirmed accepted by `execFile()` for a same-user drop (a privilege change to
  a *different* user needs root, unavailable on this dev machine to verify further).

**What's honestly not here**: this is privilege/env scoping, not filesystem or
network isolation — a scoped-env child process can still read/write any file its
`uid` can, and make any outbound connection. `egressPolicyRef` remains exactly as
unenforced as it was before this change; closing that gap for real would mean the
container-runtime or seccomp/namespaces path this repo explicitly chose not to take
on now. `uid`/`gid` restriction only does anything if the worker process itself has
the privilege to drop to them — on an unprivileged worker (the common case) it is a
no-op at best. Neither `worker/cli.ts` nor `PromptfooWorkerConfig` sets a default
`uid`/`gid` — a real deployment that wants privilege dropping must configure it
explicitly, matching how `env` scoping already requires the same.

## грань №12: "ask," adapted rather than transplanted

The original idea models an unresolved decision as an in-memory suspended `Promise`
sitting in the call stack. That doesn't fit RTAP — this is a system built entirely
around durable, crash-recoverable state, and an in-memory Promise would not survive
a worker restart, which every other mechanism here goes out of its way to guarantee.
The adaptation: `admitDispatch()` already has the right native pattern for "this
can't be decided right now, try again later" — CONCURRENCY back-pressure, which
writes no execution record and leaves the RunStep re-leasable rather than blocking
anything in-process. "Ask" reuses exactly that shape instead of inventing a second one.

- `src/execution/dispatch.ts` — `ApprovalPolicy { requiresApproval(request): boolean }`,
  a pure synchronous predicate (no suspension anywhere), and `ApprovalGate { policy,
  approvals }`. `admitDispatch()` gained an optional trailing `approvalGate` parameter;
  the check runs *after* authorization already cleared (or was bypassed) — approval
  is additive on top of a request that was already going to be admitted, never
  consulted for one that was already going to be denied on its own. `DispatchGuardResult`
  gained a fourth variant, `stage: 'ASK'` — `attempt: null`, same as `CONCURRENCY`,
  for the same reason: nothing has been decided yet.
- `src/execution/approval-store.ts` — `PendingApprovalStore`, the durable half.
  `requestApproval()` is idempotent by `runStepId` (a retried, still-pending dispatch
  never mints a second ask); `resolve()` is the "claim before effect, resolve once"
  half of the original idea — a conditional `UPDATE ... WHERE decision IS NULL`, the
  same idempotent-write pattern `OutboxStore` already used, so two racing resolvers
  (or an operator re-running a command) can never both win, and the loser is told
  which decision actually did.
- `src/db/migrations.ts` — migration 5, `pending_approvals` (`run_step_id UNIQUE`
  enforces the one-ask-per-step invariant at the schema level, not just in application
  code).
- `src/execution/run-step-executor.ts` — `executeLeasedStep()` gained the same
  optional `approvalGate` parameter, forwarded to `admitDispatch()`, and a new
  `StepResult` outcome, `ASK_PENDING`, handled identically to `ADMISSION_REFUSED`:
  nothing written, the RunStep's lease is untouched.
- `src/approval/cli.ts` — the resolver, matching this repo's existing `laws`/`worker`
  CLI pattern rather than introducing an HTTP server or webhook this repo has no
  other reason to run: `tsx src/approval/cli.ts list --db=...` and
  `tsx src/approval/cli.ts resolve --db=... --approval-id=... --decision=APPROVED|DENIED
  --decided-by=...` (also `npm run approval --`). Hand-verified end to end against a
  real database file, outside the test suite: seeded a real ask, listed it, resolved
  it, confirmed the list emptied, and confirmed a second `resolve` for the same
  `approval-id` fails with the exact decision that won and a non-zero exit code — not
  a false success.
- New law `redteam.execution/ask-is-durable-and-resolves-exactly-once` (200 trials):
  retrying admission while an ask is pending always returns the same `approvalId`,
  never mints a second one; a random `APPROVED`/`DENIED` outcome, once resolved, is
  reflected on the next `admitDispatch()` call; a second resolver racing the first
  with the opposite decision never wins. 65 laws total, 61 implemented (up from 64/60).
- `test/execution/approval-store.test.ts`, `test/execution/dispatch.test.ts`,
  `test/execution/run-step-executor.test.ts` — direct unit coverage at every layer,
  including the specific case the law generalizes: a request `evaluateAuthorization()`
  would deny on its own is never even offered to the approval policy (proven with a
  policy that records whether it was asked at all).

**What's honestly not here**: no default `ApprovalPolicy` is wired into
`PromptfooWorkerConfig` or `worker/cli.ts` — deciding *which* operations genuinely
need human sign-off is a policy-content judgment call nobody has made yet, and
guessing at one (e.g. "anything destructive") would be exactly the kind of
speculative default this README has argued against elsewhere. `NO_APPROVAL_REQUIRED`
stays what every real caller uses; the mechanism is real and wired all the way through
to a working CLI, but nothing in this repo actually asks for approval today unless a
caller explicitly supplies a policy that says so.

## §15 criterion 13, converted from declared to derived

Criterion 13 was already `MET` — `rtap/RUNBOOK.md` has existed since Phase 4.5.2's
recovery work — so there was no gap to close the way criteria 12 and 14 had one.
What was still true about it: `extraEvidence.runbookExists: true` was a human
asserting a fact, not a check proving it, the exact shape criterion 14 was in before
its own rollback-drill law. The same conversion, applied here.

- `src/laws/catalog/platform.laws.ts` —
  `redteam.platform/runbook-covers-unknown-effect-outcome` reads `RUNBOOK.md` directly
  from disk (path resolved relative to the law module's own file via `import.meta.url`,
  not `process.cwd()`, so it works the same under `npm test` and `npm run laws`
  regardless of invocation directory) and requires three markers: the literal
  `UNKNOWN_EFFECT_OUTCOME`, a named `Part A` section, and the word `operator` —
  evidencing this is a *manual* procedure, not just an incidental mention of the
  terminal reason somewhere in the file. `trials: 1`, deterministic, matching the
  handful of other laws in this catalog that check a fixed fact rather than a
  randomized property (`redteam.finding/every-finding-has-observation`, e.g.). The
  check also proves its own discriminating power inline, the same way that law
  does: it runs the marker logic against a synthetic string missing two of three
  markers first, and fails loudly if the matcher doesn't catch it — a marker-check
  that always reports zero missing would otherwise make this law a tautology.
- `src/execution/admission.ts` — criterion 13 moved from a declared field to
  `lawCriterion()`, identical to criterion 14's own conversion. `AdmissionExtraEvidence`
  loses `runbookExists` entirely — there is nothing left to honestly declare once a
  real law can check it directly.
- 66 laws total, 62 implemented (up from 65/61) — a new law, not an extension of an
  existing one, since nothing else in this catalog reads a file's content from disk.
- `test/execution/admission.test.ts` — updated to reflect criterion 13 joining the
  purely-law-backed group (now 1, 3-10, 13, 14), and the "flip every extra-evidence
  field to false" test no longer touches criterion 13 at all — there is nothing left
  on `AdmissionExtraEvidence` for it to flip.

**What's honestly not here**: the check verifies `RUNBOOK.md` *mentions* the right
things, not that its embedded code snippets (`attempts.listByRunStep(...)`, etc.)
still type-check against the real API — a renamed method would not be caught by this
law. Building that would mean extracting and compiling every fenced code block in the
file, a meaningfully larger undertaking than what criterion 13 actually asks for, and
nothing has asked for it yet.

## A production caller for the planner, and authorityFor() stops being just documentation

Phase 5's own section above already built `mixCandidates()` and `dispatchDecisions()`
— but nothing in `src/` ever called them. `test/integration/experimental-planner-slice.test.ts`
was the only place the pipeline ran end to end, the same gap `worker/cli.ts` closed
for the promptfoo vertical slice (§15 criterion 12) but for Phase 5's own planner
apparatus instead. Separately, `promotion/types.ts`'s `authorityFor()` — "what a
given promotion state authorizes the Planner to do" — had existed since Phase 5 was
first built and was only ever exercised by its own state-machine unit test:
`mixer.ts`/`dispatch.ts` compose and dispatch a batch regardless of what state (if
any) the model named in a config is actually in. Both gaps close together here,
because a production caller is exactly the thing that has a `ModelPromotionRegistry`
row to check in the first place.

- `src/planner/run-once.ts` (NEW) — `runPlannerOnce()`, the actual composition:
  `CampaignWorldMaterializer.advance()` (грань №14's snapshot-backed path, not a full
  `replay()` on every call) → `buildHistoryView()` (now including
  `buildSettledAttemptsByReason()`, which every existing planner test skipped) →
  `enumerateEligibleCandidates()` → rank (heuristic always; the configured model only
  if `authorityFor(modelState).rankAndLogCandidates`) → `mixCandidates()` →
  `dispatchDecisions()`. `modelState` is read from `ModelPromotionRegistry.get()`
  against the real database — never trusted from the caller's own config, which
  cannot be allowed to assert its own authority.
  - `authorityFor().rankAndLogCandidates === false` (OFF, or a `modelRef` never
    admitted): the model is not ranked at all.
  - `rankAndLogCandidates && !influencesRunStepCreation` (SHADOW): ranked — so a
    future caller could still log it — but `mixCandidates()` receives an empty
    model ranking. Phase 3's own line ("ranks and logs, `RunStepStore` never
    moves") redrawn here as an enforced branch, not a convention callers have to
    remember.
  - `influencesRunStepCreation && boundedShare` (EXPERIMENTAL): the real ranking
    reaches the mixer, `policy.modelShareCap` applies as configured.
  - `influencesRunStepCreation && !boundedShare` (CALIBRATED): the real ranking
    reaches the mixer with `modelShareCap` raised to `1 - explorationShare` —
    `planner/policy.ts`'s own doc comment on that field ("CALIBRATED removes it")
    had been prose since the field was added; this is the first code that acts on
    the second half of that sentence.
  - A second, additive effect of having a real `CampaignWorldState` in hand: every
    existing `mixer.ts` caller passes `BindingContext` without `world`/
    `compilerDigest` (mixer.ts's own doc comment says why — none had one), so a
    model-arm decision's `provenance` has always been `null` outside of a
    synthetic test. This caller has a real world from `materializer.advance()`, so
    it supplies both — a dispatched model-arm decision now carries a real
    `RecommendationProvenance`, not a structurally-guaranteed-empty field.
- `src/training/baselines/linear-regression-baseline.ts` — `loadFittedLinearModel()`,
  the inverse of `model-artifact.ts`'s `packageLinearModelArtifact()`: reconstructs a
  working `FittedLinearModel` from serialized `{weights, bias}` rather than re-fitting
  from training data, since a CLI invocation has a promoted model's weights on disk,
  not the training set that produced them.
- `src/planner/cli.ts` (NEW) — the thin argv/config shim, same split as
  `worker/promptfoo-worker.ts` vs. `worker/cli.ts`: `tsx src/planner/cli.ts --db=...
  --campaign-id=... --target-id=... --assessment-run-id=... --config=...` (also
  `npm run planner --`). Fail-closed config validation (malformed `catalog`/`policy`/
  `model` shapes are rejected with a message and a non-zero exit before anything
  opens the database). Hand-verified end to end against a real database file, outside
  the test suite: seeded real campaign events and a real `EXPERIMENTAL`-promoted
  model, ran the CLI, confirmed real `RunStep` rows with real `campaign_id`/
  `target_id` columns set; re-ran it and confirmed the unchanged decisions deduped
  while a fresh exploration draw correctly did not; seeded a second database with the
  same model left at `SHADOW`, ran the same config, and confirmed `ranked=6
  influencedDispatch=false` with zero `model`-arm `RunStep`s — the actual proof this
  section's title claims, not just a unit test asserting it.
- `test/planner/run-once.test.ts` (NEW, 6 tests) — no model configured; a `modelRef`
  configured but never admitted (still `OFF`, not trusted from config); `SHADOW`
  ranks but never dispatches; `EXPERIMENTAL` dispatches bounded by `modelShareCap`;
  `CALIBRATED` dispatches more of the same batch than `EXPERIMENTAL` under an
  identical policy (the concrete, observable difference `boundedShare` makes); and
  redispatch idempotency through this entrypoint specifically.
- `test/training/baselines.test.ts` — `loadFittedLinearModel()` reconstructs a model
  whose predictions match the one it was serialized from, and round-trips
  weights/bias unchanged.

**What's honestly not here**: there is still no `promotion/cli.ts` — admitting and
promoting a model to `EXPERIMENTAL`/`CALIBRATED` in a real database has no production
entrypoint of its own, only the `ModelPromotionRegistry` API this CLI reads from;
this CLI's gating gives that process real teeth once it exists, but does not itself
provide it. There is also still no durable store for a model's actual weights —
`SignedModelArtifact` carries only a `sha256` over them, so `loadFittedLinearModel()`
exists to reconstruct a model from weights a caller supplies out of band (a config
file, here), the same honest gap `packageLinearModelArtifact()`'s own doc comment
already named. And like `worker/cli.ts`, this drains one planning pass for one Target
and exits — no poll loop, no multi-Target batching; a real deployment's scheduling
loop is not built here either.

## A stale model's weights are refused, not silently scored against the wrong layout

The gap this section's own predecessor named: `PlannerModelConfig` carried no
`featureSchemaVersion`, and nothing compared a model's registered schema against
`enumerateEligibleCandidates()`'s candidates being compiled under today's real
`FEATURE_SCHEMA_VERSION`. `dot(weights, x)` has no way to notice a coordinate-layout
change on its own — a model promoted under an older feature schema would keep
producing a number for every candidate, just against the wrong coordinates, with
nothing in the ranking path erroring or even warning. `authorityFor()`'s enforcement
from the previous section answers "is this model allowed to act" — this answers "is
what it would compute actually meaningful," a different question with no existing
check.

- `src/planner/run-once.ts` — `runPlannerOnce()` now reads the full
  `PromotionRecord` (not just `.state`) from the registry, and — only for a model
  `authorityFor()` would otherwise permit to rank — compares
  `modelRecord.artifact.featureSchemaVersion` (`training/model-artifact.ts`'s own
  `SignedModelArtifact` field, set once at `packageLinearModelArtifact()` time and
  never touched again) against `features/coordinates.ts`'s `FEATURE_SCHEMA_VERSION`.
  A mismatch refuses ranking entirely — `modelRankedCount` stays `0`, exactly the
  same observable shape as `authorityFor().rankAndLogCandidates === false` — rather
  than scoring candidates against weights that no longer mean what they meant when
  they were fit.
- `PlannerRunReport` gained `modelSkipReason: string | null`, covering both this new
  case and the pre-existing "OFF or never admitted" case with a specific, readable
  explanation instead of leaving a caller to reconstruct why `modelRankedCount` is
  `0` from `modelState` alone. `planner/cli.ts` prints it when present.
- `test/planner/run-once.test.ts` — a new case: a model promoted all the way to
  `EXPERIMENTAL` (so `authorityFor()` alone would permit it) but registered under a
  different `featureSchemaVersion`, asserting `modelRankedCount === 0` and a
  `modelSkipReason` naming the mismatched versions. The three existing success paths
  (no model / `EXPERIMENTAL` / never-admitted) each gained a `modelSkipReason`
  assertion too, so the field's behavior is pinned in both directions, not just the
  new one.
- Hand-verified against a real database file: seeded a model promoted to
  `EXPERIMENTAL` under `featureSchemaVersion: '0.9.0'`, ran the CLI against real
  candidates compiled under the real `'1.0.0'` constant, and confirmed
  `ranked=0 influencedDispatch=false` with the exact mismatch reported on stdout and
  zero `model`-arm `RunStep`s among the four real rows dispatched — mandatory,
  heuristic, and exploration all proceeded normally around the refusal.
- No new law and no admission-criteria change — this is a deterministic string
  comparison with direct unit and hand-verified coverage, not a property with a
  meaningful randomization dimension; laws stay at 66 total, 62 implemented.

**What's honestly not here**: the check compares versions for exact equality only —
there is no compatibility notion (e.g. "same major version is fine"), so a caller
that deliberately wants to run an older-but-compatible model has no way to say so;
the versioned-policy discipline `PlannerPolicy`/`UtilityLabelPolicy` already use
elsewhere in this repo would be the natural fit if that need ever becomes real.

## A production caller for ModelPromotionRegistry: promotion/cli.ts

The previous two sections gave `authorityFor()` real teeth once a model has a
promotion state — but nothing in `src/` ever moved a model *into* one.
`ModelPromotionRegistry.admit()`/`applyEvent()` had existed since Phase 5 was first
built and were only ever driven from tests; giving a model a real state in a real
database meant a throwaway script, same gap `worker/cli.ts` closed for the promptfoo
vertical slice and `planner/cli.ts` closed for the mixer/dispatch pipeline, just for
the registry this time.

- `src/promotion/admit-model.ts` (NEW) — `admitModel()`: reconstructs a
  `FittedLinearModel` from serialized weights (`loadFittedLinearModel()`, the same
  reconstruction `planner/run-once.ts` already uses), wraps it in a real
  `SignedModelArtifact` (`packageLinearModelArtifact()`), and admits it. Reports
  `alreadyAdmitted` and `artifactMismatch` explicitly — `ModelPromotionRegistry.admit()`
  is intentionally idempotent by `modelRef`, silently keeping whichever artifact
  landed first; a caller who reuses a `modelRef` for a genuinely different model
  needs to know their new artifact was *not* the one that actually landed, not
  discover it later from an unexpected `sha256` on `show`.
- `src/promotion/cli.ts` (NEW) — four subcommands, the same shape `approval/cli.ts`
  established for a multi-verb tool rather than `worker/cli.ts`/`planner/cli.ts`'s
  single-purpose one:
  - `admit --db=... --model-ref=... --config=...` — config carries the same
    `{kind, weights, bias}` shape `planner/cli.ts`'s model config already uses, plus
    the artifact metadata (`featureSchemaVersion`, `taxonomyVersion`,
    `trainingDatasetRef`, `benchmarkRef`, `issuer`).
  - `promote --db=... --model-ref=... --event=...` — validated against the seven
    real `PromotionEvent` values before ever reaching the registry; an illegal
    transition (caught by the registry's own `attemptTransition()`) and an unknown
    `modelRef` both report the *specific* reason and exit non-zero, not a generic
    failure.
  - `show` / `history` — read the current state and full transition log, for
    visibility outside a test.
  - Deliberately does not decide *when* a model has earned a promotion —
    `promotion/types.ts`'s own doc comment already draws that line ("the model
    cannot promote itself... [it] belongs to RTAP policy and signed Model Registry
    metadata"): this CLI is the mechanism an operator or a future automated gate
    would call, not the judgment itself.
- `test/promotion/admit-model.test.ts` (NEW, 4 tests) — fresh admit; identical
  re-admit is a reported no-op with a matching `sha256`; a genuinely different
  config re-admitted under the same `modelRef` reports `artifactMismatch: true` while
  the registry keeps the original artifact; promoting after admit moves state through
  the same registry.
- Hand-verified end to end against a real database file: `admit` (fresh, then a
  no-op re-admit), `promote` through `OFF -> SHADOW -> EXPERIMENTAL`, `show`
  reflecting the current state and artifact fields, `history` listing both real
  transitions in order — then the failure paths: promoting an illegal event from
  `EXPERIMENTAL`, promoting an unknown `modelRef`, and `show` for an unknown
  `modelRef`, all reporting the specific reason on stderr and exiting `1`.
- No new law — `admit`/`promote`/`show`/`history` compose existing, already-law-tested
  registry behavior (`promotion/state-machine.test.ts`'s own laws cover
  `attemptTransition()`/`authorityFor()` directly); laws stay at 66 total, 62
  implemented.

**What's honestly not here**: `admit` builds a `SignedModelArtifact` with
`signature: 'UNSIGNED'` — same as `packageLinearModelArtifact()` always has, per its
own doc comment ("signing authority is an open decision"), not something this CLI
changes. `promote` performs no automated gate evaluation of its own — it does not
check A/B results, drift thresholds, or anything from §16's admission criteria before
applying an event; it trusts the caller's `--event` the same way the registry itself
always has. And like `approval/cli.ts`, there is no `list`-all-models subcommand —
each command operates on one `--model-ref` at a time.

## taxonomyVersion joins featureSchemaVersion in the stale-model check

The gap the previous `featureSchemaVersion` section named on its way out: the check
only compared the feature *schema*, not the `taxonomyVersion` a `SignedModelArtifact`
also carries — a model trained against an older vulnerability-class/strategy
taxonomy would pass the schema check cleanly and still score every candidate against
buckets (`vulnerabilityClassOf()`/`strategyOf()`'s hashed coordinates,
`features/coordinates.ts`'s `PROBE_AND_STRATEGY` group) that no longer mean what
they meant at training time. Same failure shape as the schema case, different field.

- `src/features/candidate-compiler.ts` — the `taxonomyVersion` this compiler stamps
  was a bare string literal (`'taxonomy-v1'`) duplicated inline; extracted to an
  exported `CANDIDATE_TAXONOMY_VERSION` constant, the same treatment
  `FEATURE_SCHEMA_VERSION` already had. `observation-compiler.ts` keeps its own
  separate literal — nothing requires the two compilers to agree, so this does not
  unify them.
- `src/planner/run-once.ts` — the stale-model check now compares both
  `modelRecord.artifact.featureSchemaVersion` and `.taxonomyVersion` against the
  compiler's current constants, independently. Either mismatch alone refuses
  ranking; `modelSkipReason` names exactly which field(s) mismatched (one or both),
  not a generic "stale model" message — an operator debugging why a promoted
  model isn't dispatching needs to know which of the two to fix.
- `test/planner/run-once.test.ts` — two new cases: taxonomy-only mismatch (asserts
  the schema reason is specifically absent, not just that *a* reason exists), and
  both fields mismatched together (asserts both reasons are named).
- Hand-verified against a real database file: a model promoted to `EXPERIMENTAL`
  with a matching `featureSchemaVersion` but a stale `taxonomyVersion` produced
  `ranked=0` and a skip reason naming only `taxonomyVersion`, not
  `featureSchemaVersion` — proving the two checks are genuinely independent, not
  one flag covering both.
- No new law, no admission-criteria change, same reasoning as the schema check;
  laws stay at 66 total, 62 implemented.

**What's honestly not here**: same caveat as before, now for both fields — exact
equality only, no compatibility notion for either version. And `observation-compiler.ts`'s
own `taxonomyVersion` literal is untouched; if it and `candidate-compiler.ts`'s ever
drift from each other, nothing here would notice — this check only ever looked at
the candidate side, since that's the only one the planner ever ranks.

## грань №16: model signing authority, and MODEL_ADMITTED actually requires one

Two honest gaps named repeatedly across the last several sections, closed together:
`packageLinearModelArtifact()`'s own doc comment had said "signing authority is an
open decision (FROZEN_INTEGRATION.md §13.7)" since Phase 2, and `signature:
'UNSIGNED'` was the only value this repo had ever produced; separately,
`SignedModelArtifact` never persisted a model's actual weights — `promotion/cli.ts`'s
`admit` command took them from an externally-synced `--config` file, entirely
outside the registry's own durability guarantee. `promotion/types.ts`'s own header
comment — `"the model cannot promote itself... Promotion and demotion belong to
RTAP policy and signed Model Registry metadata"` — had described signed metadata
as part of the promotion story since Phase 5's first line of code; nothing checked
one.

- `src/signing/authority.ts` (NEW) — `SigningAuthority` port: `sign()`/`verify()`
  over `SigningPayload`, scheme-prefixed signatures (`local-ed25519:<keyId>:<sig>`
  today) mirroring `SecretProvider`'s own `"<scheme>:<locator>"` split exactly, so a
  future `kms:` scheme is an addition, not a rewrite. `canonicalizeArtifactForSigning()`
  binds the *whole* envelope (every field but `signature` itself, in an explicit
  fixed order) — signing only the bare `sha256` would have left every other field
  (`modelRef`, `issuer`, `weightsRef`, ...) swappable around a still-valid digest.
- `src/signing/local-keypair-authority.ts` (NEW) — `LocalKeypairSigningAuthority`:
  real Ed25519 via `node:crypto`, not mocked, matching the same "local-but-real, not
  fake-but-real-looking" discipline `FilesystemArtifactStore`/`EnvSecretProvider`
  already established for their own local profiles. Constructed with only a public
  key it throws `SigningKeyUnavailableError` from `sign()` — a verifier can never
  forge, by construction, not by convention.
- `src/promotion/types.ts` — `SignatureGate { verified, reason? }`, a pre-computed
  verification outcome passed in as data (the pure state-machine functions in this
  file still never perform I/O themselves). `attemptModelTransition()` sits beside
  `attemptTransition()` (unchanged, still what a bare call tests standalone): defers
  to it for graph legality first, then additionally requires
  `signature?.verified === true` for `MODEL_ADMITTED` specifically — the one event
  that actually admits an artifact's claims into the promotion lifecycle.
  `OFFLINE_AND_SHADOW_GATES_PASSED`/`AB_GATES_PASSED`/etc. are untouched: the
  registry never mutates a model's stored artifact after `admit()`, so an artifact
  verified once at entry stays verified for its whole lifetime — there is nothing to
  gain by re-checking a fixed value at every later transition.
- `src/promotion/registry.ts` — `applyEvent()` gained an optional `signature`
  parameter and calls `attemptModelTransition()` instead of the bare
  `attemptTransition()`. The gate is enforced *inside* this method, not only in a
  caller-side wrapper above it — calling `applyEvent()` directly can no longer admit
  an unsigned or unverified model by skipping a convention.
- `src/artifacts/store.ts` / `filesystem-store.ts` — `ArtifactStore` gained
  `putWeights()` and a `WeightsRef { ref, kind: 'model-weights' }` type, deliberately
  never unioned with the schema-locked `EvidenceKind` — model weights must never
  silently validate wherever an `EvidenceRef` is expected. Grafted onto the existing
  content-addressed store (one hashing/path-safety implementation, two `kind`
  labels) rather than a parallel one.
- `src/training/model-artifact.ts` — `SignedModelArtifact` gained `weightsRef:
  WeightsRef | null` (`null` from `packageLinearModelArtifact()`, which stays
  synchronous and untouched — `test/training/model-artifact.test.ts`'s existing
  coverage keeps pinning exactly what it always did). `serializeLinearModelWeights()`
  extracted so `admitModel()` hashes-and-stores the *exact same bytes*
  `packageLinearModelArtifact()`'s own `sha256` was computed over, rather than
  risking two independent serializations of the same weights silently diverging.
- `src/training/sign-model-artifact.ts` (NEW) — `signModelArtifact()`, a thin async
  wrapper composing the (still-sync) packaging step with a `SigningAuthority`.
- `src/promotion/admit-model.ts` — `admitModel()` gained `artifactStore` and
  `signingAuthority` parameters: reconstruct the model, persist its weights durably
  (`putWeights()`), sign the full envelope, *then* admit — `weightsRef.ref` and
  `artifact.sha256` are guaranteed to encode the same digest by construction, both
  derived from one `serializeLinearModelWeights()` call.
- `src/promotion/cli.ts` — `admit` gained `--signing-key=`/`--key-id=`/
  `--artifacts-dir=`; `promote --event=MODEL_ADMITTED` gained `--verify-key=`/
  `--key-id=`, resolves the model's stored artifact, verifies it, and only then
  calls `applyEvent()` with the result — every other `--event` is completely
  unaffected, no new flags required. Both new async paths are wrapped in a single
  IIFE so `show`/`history`/`list`'s existing synchronous branches stay untouched.
- Five new property-tested laws, one pending (`redteam.signing/kms-profile-round-trips`
  — no live KMS/HSM endpoint in this environment, same constraint
  `env-provider.ts`/`filesystem-store.ts` already state for their own
  production-profile gaps): sign-then-verify round-trips and any single
  canonicalized field being tampered always breaks it; a verify-only authority can
  never sign, and still verifies a matching sign-mode authority's output; an
  unrecognized signature scheme (including the `'UNSIGNED'` sentinel) throws rather
  than silently reporting invalid; `putWeights()`'s digest always matches
  `packageLinearModelArtifact()`'s `sha256`; `applyEvent()` never grants
  `MODEL_ADMITTED` without a verified gate, for every way a gate can fail to be one
  (absent, explicitly unverified, or unverified with a reason). 72 laws total, 67
  implemented (up from 66/62).
- `test/promotion/signing-fixture.ts` (NEW) — `testSigningAuthority()`/`signAndGate()`,
  the one call most test call sites need (`registry.applyEvent(modelRef,
  'MODEL_ADMITTED', gate)`); reused by `admit-model.test.ts`, `run-once.test.ts`,
  and the integration slices rather than each reimplementing key generation.
- `test/promotion/admit-model.test.ts` / `registry.test.ts` — extended for the new
  signature gate and `putWeights()` persistence; every existing planner-slice
  integration test updated to sign its fixture model before promoting it, since
  `MODEL_ADMITTED` now genuinely requires it.

**What's honestly not here**: no KMS/HSM profile (the one pending law names this
directly — no live endpoint to test a real client against, same gap the secrets and
artifact ports already carry for their own production profiles). No key rotation or
revocation — a `keyId` is opaque metadata carried in the signature string, not
checked against any registry of currently-valid keys, so a compromised key cannot be
un-trusted without a mechanism this facet does not build. Only `MODEL_ADMITTED` is
signature-gated, deliberately (see `types.ts`'s own doc comment) — later transitions
trust the artifact verified once at entry, which means a signing key compromised
*after* a model is already SHADOW/EXPERIMENTAL/CALIBRATED has no way to retroactively
invalidate it. And `promote`'s other events (`AB_GATES_PASSED`,
`DRIFT_OR_QUALITY_REGRESSION`, etc.) still perform no automated gate evaluation of
their own — signing proves an artifact is authentic, not that a model has actually
earned the promotion the caller is asserting; that judgment-layer gap (§16's own
admission criteria in `ADAPTIVE_REDTEAM_RUNTIME.md`, a different §16 from this
facet's number — genuinely confusing, not the same thing) is still wide open.

## грань №17: duo-static and duo-llm reach commitFencedObservation() too

Promptfoo already went through `executeLeasedStep() -> commitFencedObservation()`;
duo-static and duo-llm did not — and couldn't, unmodified. One promptfoo probe
produces exactly one result; one duo-static scan or duo-llm redteam run produces
zero-to-many findings/attacks from a single native invocation.
`commitFencedObservation()` assumed exactly one Observation per dispatched attempt,
and calling it in a loop for the same `executionAttemptId` would fail from the
second finding on — `bindNativeResult()`'s own `ATTEMPT_ALREADY_TERMINAL` rejection,
since the first call already marks the attempt `COMPLETED`. Binding and
terminalizing are properties of the *attempt*, not of any individual Observation.

- `src/pipeline/commit-fenced-observation.ts` — `commitFencedObservations()`
  (plural), the real primitive: one bind, N inserts, one terminalize, all inside
  the existing single transaction. An empty `pairs` array is a legitimate,
  successful outcome (a clean scan that finds nothing still binds and terminalizes
  the attempt as `COMPLETED`), not a normalization failure.
  `commitFencedObservation()` (singular) is now a thin wrapper around this with a
  one-element array — its own signature is unchanged, so every pre-existing caller
  (`worker/promptfoo-worker.ts`, `execution-safety.laws.ts`,
  `test/pipeline/commit-fenced-observation.test.ts`) keeps compiling and behaving
  identically.
- `src/worker/duo-static-worker.ts` / `duo-static-cli.ts` (NEW) — mirrors
  `promptfoo-worker.ts`'s admission/dispatch/commit/settlement composition exactly,
  adapted for what's actually different: a duo-static scan declares
  `operationFamily: 'static-scan'` and `destructive: false` — a static scan reads
  code, it doesn't attack a live target, so it doesn't need the exclusivity a
  destructive engine's concurrency class enforces.
- `src/worker/duo-llm-worker.ts` / `duo-llm-cli.ts` (NEW) — same composition, with
  one more real difference: `DuoLlmCliAdapter.run()` is capability-gated
  (`adapters/capability.ts`), and as of Phase R every one of its four
  `DECLARED_CAPABILITIES` is `false` — every dispatch through this worker resolves
  to a capability rejection before `execFn` is ever touched, mapped here to the
  purpose-built `CAPABILITY_UNSUPPORTED` terminal reason (not a generic
  `FAILED_BEFORE_EFFECT`), so the RunStep's own failure record says precisely why.
  Still declares `destructive: true` (same as promptfoo) — a duo-llm dispatch is a
  real attack in intent, currently gated shut, not a non-destructive engine. This
  worker deterministically produces only `CAPABILITY_UNSUPPORTED`-terminated
  RunSteps until §9 Phase R's four gates are met on `duo-agents`' own side — that's
  this worker doing its job correctly, not a sign anything is broken; the moment
  those gates are met, this file needs no change at all, only
  `duo-llm/run.ts`'s `DECLARED_CAPABILITIES` does.
- Three new property-tested laws
  (`src/laws/catalog/pipeline.laws.ts`): `commit-fenced-observations-shares-one-attempt`
  (N pairs, one bind, one terminalize, every stored Observation carries the same
  attempt id), `commit-fenced-observations-empty-pairs-still-completes`, and
  `commit-fenced-observations-fencing-rejects-all-or-nothing` (a fenced-out attempt
  commits none of its N pairs, not a partial subset — the same §7.1 lease-supersede
  race the execution-safety fencing laws already exercise). 75 laws total, 70
  implemented (up from 72/67).
- `test/worker/duo-static-worker.test.ts` (5 tests) / `duo-llm-worker.test.ts`
  (3 tests) (NEW) — including the capability-rejection path for duo-llm actually
  producing `CAPABILITY_UNSUPPORTED`, not a generic failure.
- `npm run worker:duo-static` / `npm run worker:duo-llm` (NEW scripts) — same
  `--db=... --assessment-run-id=... --config=...` shape `worker:promptfoo` already
  established.

**What's honestly not here**: duo-llm's worker is real and fully composed, but it
has never actually executed an LLM attack against anything — every dispatch fails
capability-gated by design, so this path is proven correct for the rejection case
only; the day `duo-agents`' Phase R gates open, the *success* path (real findings,
multiple pairs, real evidence materialization) will be exercised by this worker for
the first time outside a synthetic law fixture. Neither new worker has a real crash
matrix of its own — `test/execution/crash-kill-points.test.ts` still only exercises
the promptfoo path; the same fenced-commit mechanism is shared and law-tested
generically, but a worker-specific crash-recovery integration test for duo-static/
duo-llm does not exist yet.

## ADAPTIVE_REDTEAM_RUNTIME.md §16: a model admission report, greenfield

The judgment-layer gap the previous section named on its way out, closed the same
way `execution/admission.ts`'s `evaluatePhase5Admission()` closed §15's own gap:
a real report, evaluated against the current `LawRegistry` and a specific model's
real evidence, not asserted by prose. Designed via a real Explore agent (grounding
every claim about what mechanism exists or doesn't in actual file:line reads) and a
Plan-agent design review before any code was written — the review caught two real
mistakes in the first draft: two "solid" mechanisms turned out not to be laws at all
(pure functions needing real per-model data, not something `LawRegistry.runAll()`
can answer), and one criterion was mapped to the wrong law entirely (worker-loss
fallback pointed at execution-lease reclaim; the correct match is the
model-inference fallback `redteam.planner/frozen-failure-falls-back-to-heuristic`
already names, per §16's own §11 cross-reference).

Two structural differences from `admission.ts`, both required by what §16 actually
asks: it's **per-model** (§15 is platform-wide; "signed model artifact," "positive
lift" are inherently about one candidate's evidence), and its three tiers are
**additive** (Shadow always applies; Experimental adds six more; Calibrated adds
five more) — a model can legitimately be Shadow-admissible without being
Experimental-admissible, so the report exposes `shadowAdmissible` /
`experimentalAdmissible` / `calibratedAdmissible` separately rather than one flat
boolean.

- `src/promotion/phase16-admission.ts` (NEW) — `evaluatePhase16Admission(registry,
  promotionRegistry, modelRef, evidence = {}, seed = 1)`. Three evidence tiers, not
  `admission.ts`'s two: `lawCriterion()` (a real `LawRegistry` property test, same
  as `admission.ts`), `evidenceCriterion()` (a caller-supplied *real computed
  result* of an existing pure function — `training/splits.ts`'s
  `checkNoLeakage(): LeakageCheck`, `training/admission-gate.ts`'s
  `evaluateAdmissionGate(): AdmissionGateResult` — not a law, since neither can run
  from a bare seed, and not a declared boolean either, since discarding a real
  computed result down to `true`/`false` would throw away genuine evidence), and
  `declaredCriterion()` (a caller-supplied fact for a criterion with **zero
  mechanism anywhere in this repo** — the honest majority of §16's 17 criteria).
  17 criteria total (6 Shadow / 6 Experimental / 5 Calibrated) plus 6 stop
  conditions.
- Stop conditions get a **third status** `admission.ts`'s binary MET/NOT_MET never
  needed: `'CLEAR' | 'TRIGGERED' | 'NOT_MONITORED'`. A stop condition with no
  mechanism to check it must not silently read as "not triggered" (false optimism —
  hides a real failure mode) nor as "triggered" (false pessimism — blocks every
  model forever until every mechanism exists, defeating the point of a graduated
  gate). Only `TRIGGERED` blocks admissibility; `NOT_MONITORED` is disclosed but
  never blocks — the same philosophy this codebase's gates already follow: block on
  positive evidence of a problem, never on absence of monitoring.
- Real mechanisms this report reuses rather than re-derives: `shadow.1`
  (provenance/schema currency) reuses the exact `featureSchemaVersion ===
  FEATURE_SCHEMA_VERSION` comparison `planner/run-once.ts` built two phases ago;
  `shadow.2` composes `redteam.artifact/weights-ref-digest-matches-artifact-sha256`
  (грань №16) with a direct check that *this specific* model actually has a real
  signature and `weightsRef` (a model admitted by calling
  `packageLinearModelArtifact()` directly, bypassing `admitModel()`, would still be
  unsigned — proven by a real test, not asserted); `experimental.4`/`stop.6` reuse
  `redteam.planner/stale-recommendation-is-not-executed`; `experimental.5`/`stop.3`
  reuse both arm-mix laws; `stop.5` reuses both replay-fingerprint laws.
- `shadow.5` (a baseline comparison was reported) and `stop.1` (the model doesn't
  beat the baseline) are deliberately two different criteria over the same
  `evidence.baselineComparison`, not one — the first asks whether a comparison
  exists at all, the second asks who won. Conflating them would make a losing
  comparison indistinguishable from no comparison at all.
- New law: `redteam.shadow/inference-is-deterministic-for-same-input`
  (`src/laws/catalog/shadow.laws.ts`, 100 trials) backs Shadow criterion 6 — not
  treated as true by construction just because `predict()` is a pure dot product;
  this codebase's own precedent (criteria 13/14 in `admission.ts`) is that nothing
  is MET without a real check, however obvious. 76 laws total, 71 implemented (up
  from 75/70).
- `test/promotion/phase16-admission.test.ts` (NEW, 10 tests) — structural shape (17
  criteria across three tiers, 6 stop conditions); a fully signed, fully evidenced
  model reaching every tier including `calibratedAdmissible`; a `modelRef` never
  admitted failing everything; a model admitted via a bare unsigned artifact failing
  only `shadow.2`; evidence-backed criteria failing closed when their evidence is
  absent *or* when a real `LeakageCheck` genuinely reports overlap (constructed by
  reusing the same train/holdout examples on both sides — a real failure, not
  simulated); a **tier-scoped flip** (per the Plan-agent review: a single
  flip-everything test wouldn't catch a tier-boundary bug) proving only
  `calibratedAdmissible` moves when only Calibrated-tier evidence is withdrawn; the
  `NOT_MONITORED`/`TRIGGERED` distinction on stop conditions, including a losing
  `baselineComparison` blocking `shadowAdmissible` even though every Shadow
  criterion still individually passes.

**What's honestly not here**: this is a report, not a gate — like
`evaluatePhase5Admission()`, nothing in this repo automatically blocks a `promote`
call on its output (a real CLI to actually *see* the report landed later — see
"A production caller for evaluatePhase16Admission" below). Of the 17 criteria and
6 stop conditions, roughly half are genuine, individually named gaps with no
mechanism anywhere in this repo, each nameable as its own future
facet rather than pretended away: a unique-findings-per-100-calls lift metric; a
taxonomy-class-keyed coverage regression check (`pipeline/report.ts`'s
`buildCoverage()` is run-generic today); a bounded error/timeout rate aggregation
over the real per-terminal-reason counts `features/history-view.ts` already tracks;
target/time holdout dimensions inside `planner/ab.ts`'s A/B gate (today it computes
exactly one comparison over whatever outcomes it's handed); a model/feature drift
detector (`DRIFT_OR_QUALITY_REGRESSION` is purely a manually-supplied event today);
an artifact-version rollback mechanism (`ModelPromotionRegistry` stores exactly one
artifact per `modelRef` forever); a unified reason-codes surface (`FrozenSignal
.reasonCodes`, `modelSkipReason`, `TransitionLogEntry.reason` stay separate); a
"critical-class" taxonomy/policy-limit concept; and per-label traceability to a
specific source Observation (`TrainingExample` carries `campaignId`/`targetId`/
`probeId`/`occurredAt`, not a `sourceObservationId`). "Utility label ownership"
(half of `shadow.4`) may never be law-backable at all — it's an organizational fact,
not a code property.

## грань №18: key rotation and revocation for the model-signing authority

грань №16 hardcoded exactly one active signing keypair — the `keyId` embedded in
every signature (`local-ed25519:<keyId>:<sig>`) was parsed but never looked up
against anything, so there was no way to rotate a key or invalidate a compromised
one. `signing_keys` (migration 6) makes `keyId` load-bearing.

- `src/signing/key-store.ts` (NEW) — `SigningKeyStore`: one row per `keyId`, never
  per issuer (the signature only ever carries a `keyId`; `issuer` is descriptive
  metadata on the record). Rotation needs no state transition at all — registering
  a new `keyId` *is* the rotation; an old key is never marked "superseded," it
  stays resolvable and trusted until explicitly revoked. `revoke()` is idempotent
  (`alreadyRevoked: true` on a repeat, original `revokedAt`/`revokedReason`
  preserved, never overwritten) and deliberately has no `unrevoke()` — a mistaken
  revocation gets a new `keyId` registered, not a resurrected old one, so the audit
  trail stays honest that this specific key was, at some point, distrusted.
- `src/signing/key-store-verifying-authority.ts` (NEW) —
  `KeyStoreVerifyingSigningAuthority`: resolves a signature's embedded `keyId`
  against the store, checks revocation, then delegates the actual crypto to a
  freshly-constructed `LocalKeypairSigningAuthority` (грань №16's class, left
  completely unmodified — zero duplication, zero new risk to its own
  `sign-then-verify-roundtrips`/`unsupported-signature-is-rejected-not-ignored`
  laws). Structurally verify-only: `sign()` unconditionally throws, since this
  class only ever composes public key material — nothing in its shape has
  anywhere to put a private key.
- `src/promotion/types.ts` — `SIGNATURE_GATED_EVENTS` grows from `{MODEL_ADMITTED}`
  to `{MODEL_ADMITTED, AB_GATES_PASSED}`, deliberately not every forward gate: the
  stored artifact's bytes can't change after admission, so re-verifying the same
  signature at a later gate would just re-prove what admission already proved —
  what *can* change is revocation status, checked as one indexed lookup, no
  `SecretProvider` round-trip. `AB_GATES_PASSED` specifically because
  `authorityFor()` shows `EXPERIMENTAL -> CALIBRATED` is the one transition where
  `boundedShare` flips from bounded to unbounded.
- `src/promotion/revocation-sweep.ts` (NEW) — `findModelsOnRevokedKeys()` +
  `sweepRevokedKeyDemotions()`. `TRANSITIONS` itself (`promotion/types.ts`) is
  deliberately *not* edited to add a uniform demotion edge — it's sourced verbatim
  from `ADAPTIVE_REDTEAM_RUNTIME.md`/`FROZEN_META_HARNESS.md`'s own diagrams, both
  of which document `INTEGRITY_OR_POLICY_FAILURE -> OFF` from `CALIBRATED` only, so
  editing it to add an edge neither document declares would make the code diverge
  from its own cited source of truth. The sweep pays that discipline's real cost
  instead — three different per-state routes to `OFF` (`CALIBRATED`: direct
  `INTEGRITY_OR_POLICY_FAILURE`; `SHADOW`: the only real single-hop edge,
  `ARTIFACT_OR_SCHEMA_INVALID`, an imperfect semantic fit but the one that legally
  exists; `EXPERIMENTAL`: two hops, `SAFETY_OR_COVERAGE_REGRESSION` then
  `ARTIFACT_OR_SCHEMA_INVALID`) — rather than inventing an edge. Idempotent and
  race-safe for free: `applyEvent()` always re-reads current state, so sweeping
  twice just produces harmless `allowed:false` log entries on the repeat.
- `src/signing/cli.ts` (NEW) — `register`/`revoke`/`list`/`show`, its own CLI
  (parallel to `promotion/cli.ts`/`approval/cli.ts`/`worker/cli.ts` — every other
  domain here already gets its own). `revoke` prints every currently-promoted model
  on that key in the same output as the revocation itself — detection happens at
  the moment of revocation, not left to a separately-remembered later sweep. Never
  writes to `model_promotions` itself (read-only via
  `ModelPromotionRegistry.listAll()`) — revoking a key and demoting the models it
  signed stay two separate, explicit, auditable actions.
- `src/promotion/cli.ts` — new `audit-revocations --db=... [--sweep]` subcommand
  (reports affected models; `--sweep` actually demotes them) and `promote` no
  longer needs `--verify-key=`/`--key-id=` at all — both gated events resolve the
  signing key automatically through the store now.
- Seven new property-tested laws (`src/laws/catalog/signing.laws.ts`) covering: the
  keystore resolves a signature by its embedded `keyId`; an unknown `keyId` fails
  closed; rotation preserves old-key verifiability; a revoked key fails
  verification; `AB_GATES_PASSED` is blocked by a revoked key exactly like
  `MODEL_ADMITTED`; `OFFLINE_AND_SHADOW_GATES_PASSED` stays ungated (proving the
  gate is precisely `{MODEL_ADMITTED, AB_GATES_PASSED}`, not "everything"); and
  `sweepRevokedKeyDemotions()` uses only legal per-state `TRANSITIONS` edges. 83
  laws total, 78 implemented (up from 76/71).
- `test/signing/key-store.test.ts` (8) / `key-store-verifying-authority.test.ts`
  (4) / `test/promotion/revocation-sweep.test.ts` (5) (all NEW).

**What's honestly not here**: no automatic sweep trigger — `audit-revocations
--sweep` is an operator-run command, not something a revoke automatically cascades
into; a revoked key's already-promoted models stay promoted until someone runs the
sweep. No notion of key expiry (only explicit revocation) and no multi-signature/
threshold scheme. The `EXPERIMENTAL` demotion path's `SAFETY_OR_COVERAGE_REGRESSION`
hop is a real, legal, but semantically imperfect fit for "this key turned out to be
untrusted" — the honest state of things until a human resolves the asymmetry at the
frozen-document level, the same class of open decision this README already tracks
for other cross-document naming drift.

## грань №19: admission runs before lease — a worker-level concurrency precheck

`RunStepStore.lease()` unconditionally bumps `lease_generation` (the fencing token)
before any admission check runs. `executeLeasedStep()`'s own doc comment already
named this "Known cost, not yet paid down": a CONCURRENCY refusal — the campaign's
steady state under a `TARGET_SERIAL` target, not a fault — had already fenced out a
genuinely in-flight prior attempt for nothing. Real workers (грань №17) made this a
measurable, not just theoretical, gap.

- `src/runsteps/store.ts` — `lease()`'s candidate SELECT is factored into a private
  `findLeaseCandidate()`, shared with the new `peekLeasable()` (non-mutating
  look-ahead at what `lease()` would claim next) so the two cannot structurally
  disagree about what "leasable" means. `LeaseOptions` gains an optional `stepId`
  so a caller can claim the specific row it already peeked, not just "whichever is
  oldest." `lease()`'s own transaction/UPDATE logic is untouched.
- `src/execution/concurrency-scheduler.ts` — `reserve()`'s conflict computation
  (everything before its one side-effecting `INSERT`) is factored into a private
  `evaluateConflict()`, shared with the new `probe()` (the read-only "would this
  succeed" question). `reserve()`'s own behavior is unchanged.
- `src/execution/dispatch.ts` — new `probeConcurrency()`, placed next to
  `admitDispatch()` so a reader auditing "why isn't there an authorization
  equivalent" finds the answer right there. Deliberately concurrency-only, for two
  separate reasons, not one: `AuthorizationProvider` is a port, not a pure
  function — `AuditingAuthorizationProvider` (already in this tree) writes an
  audit-log row on every `authorize()` call, so a generic precheck would silently
  double every entry the moment that decorator is wired in; and грань №12's durable
  `PendingApproval` row is written from *inside* `admitDispatch()`
  (`requestApproval()`, idempotent by `runStepId`) — a pre-lease ASK precheck would
  have to duplicate that idempotency outside `admitDispatch()`, or write the
  durable row before a lease even exists. `admitDispatch()` itself is unchanged.
- `src/execution/run-step-executor.ts` — new `leaseWithConcurrencyPrecheck()`:
  peek → `probeConcurrency()` → targeted `lease({stepId})` only if clear. Returns
  `LEASED` / `BLOCKED` (nothing leased — the fix) / `RACED` (the targeted lease
  lost the row to a competing lease between peek and this call — the same
  cross-process boundary `RunStepStore`'s own doc comment already draws, not a new
  one). Does not call `executeLeasedStep()` itself, and `executeLeasedStep()` is
  completely unchanged — a step admitted via the precheck still runs the real,
  unmodified `admitDispatch()` as the authority.
- `src/worker/promptfoo-worker.ts` / `duo-static-worker.ts` / `duo-llm-worker.ts` —
  each drain loop restructured identically: peek a candidate, handle the malformed
  (`campaignId`/`targetId` null) case with a real targeted lease as before, else
  build the request and call `leaseWithConcurrencyPrecheck()`. A `BLOCKED`
  candidate is added to an `excludeIds` set for the rest of that drain pass (so the
  loop keeps making progress on whatever else is leasable) rather than being
  retried forever.
- Five new laws (`src/laws/catalog/execution-safety.laws.ts`): `peekLeasable()`
  always agrees with what `lease()` would claim (and `excludeIds` genuinely
  excludes); `probe()` always agrees with `reserve()`; the actual fix, proven
  end-to-end by comparing the old lease-first strategy against the new
  peek/probe strategy on an identical CONFLICT scenario — the old one always bumps
  `lease_generation` on a foreseeable refusal, the new one never does;
  `authorize()` is called exactly 0 times during the precheck and exactly 1 time
  during real admission (a spy-provider regression guard against the precheck's
  scope silently widening); and — the honest complement to the fix — an
  AUTHORIZATION or ASK refusal on a precheck-leased step still bumps
  `lease_generation` exactly as before, pinned explicitly rather than left as
  unverified prose. 88 laws total, 83 implemented (up from 83/78).

**What's honestly not here**: AUTHORIZATION and ASK refusals still pay the same
wasted `lease_generation` bump they always have — this fix is deliberately
concurrency-only (see `probeConcurrency()`'s doc comment for exactly why a cheap
precheck doesn't exist for either). A fuller fix — fusing the lease claim and the
full admission decision into one transaction, rolling back only on CONCURRENCY —
was designed and rejected: its central atomicity argument ("only one `DatabaseSync`
connection in this architecture") doesn't actually hold, since `worker/cli.ts` and
`approval/cli.ts` are genuinely separate processes/connections against the same
SQLite file, which is exactly the scenario грань №12's ASK mechanism depends on
operationally. The narrower precheck here also touches less of the hottest,
heaviest-tested code (`admitDispatch()`, `executeLeasedStep()` are both completely
unmodified) for the same practical win in the common case.

## грань №20: assessment_runs — the owning row for assessment_run_id

`assessment_run_id` sat as an unowned key on seven tables (`run_steps`,
`campaign_events`, `observations`, `planner_dispatch_log`, `execution_attempts`,
`authorization_receipts`, `pending_approvals`), with nowhere to record two
currently-orphaned facts: `wiki/Arch_Overlay/FROZEN_INTEGRATION.md`'s
`intelligence_status=DEGRADED` (the planner falling back to the heuristic baseline)
and `rankCandidates().usedFallback`/`fallbackReason` (`src/shadow/rank.ts`),
computed by every call and discarded by `runPlannerOnce()`.
`wiki/Arch_Overlay/ARCH_CLAUDE_TRANSFER.md` §2.4 step 4 names the gap and the exact
shape.

- `src/db/migrations.ts` — migration 7, `assessment_runs(assessment_run_id PK,
  campaign_id, intelligence_status DEFAULT 'HEALTHY', intelligence_status_updated_at,
  ever_degraded_at, started_at, coverage_acceptance, accepted_by, accepted_at)`. No
  `FOREIGN KEY` — none of the seven referencing tables has ever declared one, and
  retrofitting enforcement would break every existing direct insert that predates an
  assessment_runs row.
- `src/planner/assessment-run-store.ts` (NEW) — `AssessmentRunStore`, living next to
  `run-once.ts` (its one real caller) rather than a new top-level directory, the
  same reasoning `execution/approval-store.ts` living beside its own hot caller
  (`admitDispatch()`) already establishes. `start()` is the only row-creator,
  idempotent by campaign, throws `AssessmentRunCampaignMismatchError` on a genuine
  mismatch. `recordIntelligenceStatus()` is deliberately non-monotonic — every call
  unconditionally overwrites `intelligence_status` with that call's own result,
  matching `FROZEN_INTEGRATION.md`'s own framing of worker unavailability as
  transient ("после восстановления worker выполняет replay") and what a
  present-tense field name implies — and a safe no-op against a row that doesn't
  exist, never a throw. `ever_degraded_at` is the honest complement: a separate
  column, stamped once on the first-ever transition into DEGRADED via a `CASE`/
  `COALESCE` inside the same `UPDATE`, never cleared by any later HEALTHY write —
  the permanent audit trail the live status field itself deliberately does not
  carry. `acceptCoverage()` is idempotent first-wins (`PendingApprovalStore.resolve()`/
  `SigningKeyStore.revoke()`'s exact idiom), a free-text `note` (matching
  `signing_keys.revoked_reason`'s shape), not gated on `intelligenceStatus`.
- `src/planner/run-once.ts` — `PlannerRunDeps` gains an optional `assessmentRuns`
  (same slot pattern as `registry`/`materializer`/`attempts`); `PlannerRunReport`
  gains `intelligenceStatus`/`intelligenceStatusRecorded`. The model-arm's
  `ranking.usedFallback` sets `intelligenceStatus` regardless of whether
  `authority.influencesRunStepCreation` — DEGRADED describes the model's own
  health, not whether its output reached dispatch. Recorded in the same process,
  right before `return` — not a separate, skippable step.
- `src/planner/dispatch.ts`/`src/pipeline/report.ts` — **not touched at all**.
- `src/planner/cli.ts` — calls `assessmentRuns.start()` before `runPlannerOnce()`
  on every invocation (idempotent); logs `intelligence: ${report.intelligenceStatus}`.
- `src/assessment-runs/cli.ts` (NEW) — `start`/`show`/`list`/`accept-coverage`, own
  top-level directory even though its store lives in `planner/`, matching
  `approval/cli.ts`'s split from `execution/approval-store.ts`.
- Six new laws (`src/laws/catalog/platform.laws.ts`, the file
  `ARCH_CLAUDE_TRANSFER.md` names for this fix): `start()`'s idempotent-by-campaign
  creation and loud mismatch; `intelligence_status` reflecting only the latest
  call; `ever_degraded_at`'s separate sticky semantics; `acceptCoverage()`'s
  exactly-once claim; `buildAssessmentReport()`'s outcome pinned as independent of
  `coverage_acceptance` (a checkable guard against future accidental coupling, not
  a change to the function); and a real `rankCandidates()` fallback round-tripping
  into a durable DEGRADED row. 94 laws total, 89 implemented (up from 88/83).

**Design harness, briefly**: three independent designs were diverged (dispatch-owned
automatic creation + sticky/permanent DEGRADED + a new report refusal; explicit
`start()` + non-monotonic status + report left untouched; zero-core-touch with all
persistence pushed into the CLI) and scored by four blind judges. The explicit-`start()`
design won clearly on three of four axes. The other two had real, judge-found
problems: sticky DEGRADED combined with a report refusal meant one transient model
hiccup would permanently gate every future report for that assessment run — a
genuine proportionality flaw, not just a stylistic one, and `buildAssessmentReport()`
turned out to have zero production callers today so the refusal wouldn't even have
gated anything live. The zero-core-touch design deferred the DB write to a separate
step in the CLI, after `runPlannerOnce()` had already durably committed the
degraded-ranked dispatch — a verified, concrete data-loss window (a crash between the
two steps silently loses exactly the DEGRADED signal) that the winning design avoids
by writing in the same process, same call. One flaw was also found and fixed in the
winning design itself before implementation: its proposed end-to-end test used a
`Proxy` trick on the model's weights array that, traced through the *entire*
`runPlannerOnce()` call rather than just the `rankCandidates()` call it was tested
against in isolation, would have thrown inside `digestOfWeights()` — outside any
try/catch — rather than inside the intended fallback path. Replaced with a simpler,
honestly-scoped law that proves the round trip one layer below `runPlannerOnce()`
instead of a fragile, false claim of full end-to-end coverage.

**What's honestly not here**: `intelligence_status=DEGRADED` is not reachable in
production today — `loadFittedLinearModel()`'s `dot()` (`training/baselines/
linear-regression-baseline.ts`) is total (`weights[i] ?? 0`) and cannot throw
through any real, config-supplied weights, so `rankCandidates()`'s fallback branch
is currently dead code from `runPlannerOnce()`'s own real model-loading path. The
plumbing is correct and forward-compatible — the day a model backend that can
genuinely fail exists, DEGRADED tracking works with zero further changes — but no
operator will see a real DEGRADED row from today's linear-regression model. Only
`planner/cli.ts` calls `AssessmentRunStore.start()`; every other surface that
references `assessment_run_id` today (workers, observation commit, approval
requests) leaves its rows exactly as unowned as before this migration. No FK
enforcement, no backfill for a database migrated with pre-existing orphaned rows.

## A production caller for evaluatePhase16Admission

`evaluatePhase16Admission()` existed with no way to actually see its output against
a real database and a real model — the same gap `worker/cli.ts` closed for
`executeLeasedStep()` and `planner/cli.ts` closed for the mixer/dispatch pipeline,
here for the §16 admission report.

- `src/promotion/cli.ts` — new `admission --db=... --model-ref=... [--evidence=...]`
  subcommand. `--evidence` is optional and points to a JSON file shaped like
  `Phase16Evidence`; omitted entirely, the report still runs — every evidence-backed
  and declared criterion honestly shows `NOT_MET` and every declared-only stop
  condition shows `NOT_MONITORED`, which is exactly what "no evidence supplied"
  should look like, not an error. `validatePhase16Evidence()` shape-validates both
  real-computed-result fields (`datasetLeakageCheck`, `baselineComparison`) field by
  field — this CLI does not recompute `checkNoLeakage()`/`evaluateAdmissionGate()`
  itself; an operator runs those against the model's real training artifacts and
  supplies the result, the same relationship every other config this CLI parses
  already has to the fact it asserts.
- Hand-verified against a real database file: admitted a real signed model
  (`admitModel()`, real Ed25519 keypair, real `FilesystemArtifactStore`), ran
  `admission` with no `--evidence` and confirmed every evidence-backed/declared
  criterion read `NOT_MET` and the three declared-only stop conditions read
  `NOT_MONITORED` with `shadowAdmissible=false`; ran it again with a real evidence
  file (`datasetLeakageCheck`, `baselineComparison`, `utilityLabelOwnershipDocumented`)
  and confirmed `shadow.1/3/4/5` flipped to `MET` and `shadowAdmissible=true`, while
  `experimentalAdmissible` correctly stayed `false` on the criteria that evidence
  file didn't cover; confirmed a malformed evidence file (`clean` as a string, not a
  boolean) fails closed with a specific message and exit code `1`.
- No new law — this is argv parsing and JSON validation composing an already-tested
  function, not new behavior to prove; laws are unaffected by this facet.

**What's honestly not here**: no way to *compute* `datasetLeakageCheck`/
`baselineComparison` from this CLI itself — that gap is closed separately (see
"A real evidence computer for the admission report" below), which produces exactly
this JSON shape. And like every other report in this repo, `admission`'s output is
advisory only — nothing wires it into `promote`, so an operator can still run
`promote --event=AB_GATES_PASSED` on a model this report would call inadmissible;
closing that loop is a deliberate non-goal here, the same as it is for
`evaluatePhase5Admission()`.

## A real evidence computer for the admission report

`promotion/cli.ts admission --evidence=...` named this gap on its way out: nothing
actually *computed* `datasetLeakageCheck`/`baselineComparison`, an operator had to
hand-author the JSON. This is that computation, as its own small tool — a small,
direct extension of what was just built, not a new report shape.

- `src/training/admission-evidence-cli.ts` (NEW) — `tsx
  src/training/admission-evidence-cli.ts --dataset=... --split=target|campaign|
  vulnerability-class|time [--holdout=... | --holdout-cutoff=...] --model-config=...
  [--model-name=...] [--out=...]`. Splits a real `TrainingExample[]` export via
  `training/splits.ts`'s real `splitByTarget()`/`splitByCampaign()`/
  `splitByVulnerabilityClass()`/`splitByTime()`, runs `checkNoLeakage()` against the
  same identity the split grouped by (for `time`, which deliberately groups by
  nothing — the same target legitimately has examples on both sides of a temporal
  cutoff — `targetId` is the most operationally meaningful group to still check,
  documented as a real choice, not treated as if `time` needed no leakage concept at
  all), fits the candidate against every implemented baseline (`random`,
  `fixed-order`, `heuristic` — not just `heuristic` alone, so `comparedAgainst`
  reports honestly against everything this repo can actually compare, matching
  `NOT_IMPLEMENTED_BASELINES`'s own framing), and emits exactly `{datasetLeakageCheck,
  baselineComparison}` — ready to use directly as (or merge into) a
  `promotion/cli.ts admission --evidence=` file.
- Deliberately takes an already-exported `--dataset=` file, not a live database —
  `training/dataset-exporter.ts`'s `exportDataset()` itself has *no production
  caller anywhere in this repo*, a real finding from building this: only
  `test/training/fixtures.ts`'s synthetic corpus exercises it. Assembling real
  `HistoricalRecord[]` from `ObservationStore`/`CampaignEventStore` — there is no
  `listByCampaign()` on `ObservationStore`, only `listByAssessmentRun()` — is a
  genuine, separate, larger gap this tool does not close; see below.
- Hand-verified end to end, not just against synthetic inputs in isolation: built a
  real dataset export and a real fitted linear-regression model, ran the tool with
  `--split=target`, fed its exact output into `promotion/cli.ts admission
  --evidence=` against a real signed model in a real database and confirmed
  `shadow.1/3/5` flipped to `MET` — the full chain, not two pieces tested apart.
  Also verified: `--split=time` honestly reports `clean: false` with the expected
  overlapping target (proving the leakage check isn't silently skipped for the one
  strategy where overlap is structurally normal); an empty holdout, a malformed
  dataset entry, and a malformed model config all fail closed with a specific
  message and exit code `1`.
- No new law — this composes already-tested functions (`checkNoLeakage()`,
  `evaluate()`, `evaluateAdmissionGate()`) via argv parsing and JSON validation, the
  same category as `promotion/cli.ts admission` itself.

**What's honestly not here**: `exportDataset()` still has no production caller —
producing the `--dataset=` input this tool needs means either a throwaway script
today or a future CLI that joins `ObservationStore`/`CampaignEventStore` into real
`HistoricalRecord[]`, which does not exist. This tool only ever names the *candidate*
model by its config file; it has no notion of pulling weights from a
`ModelPromotionRegistry` record automatically, so an operator re-supplies the same
`{kind, weights, bias}` shape here and again to `promotion/cli.ts admit` separately.

## The SARIF report surface, and the payload-inlining law stops being pending

ARCHITECTURE.md §3.3 names three report surfaces — "build JSON/Markdown/SARIF
reports" — and the context-map ANSI draws all three, but only JSON and Markdown were
ever built. `redteam.artifact/public-report-never-inlines-payload` sat `pending` with
the reason "No Report Renderer exists yet", even though `pipeline/report.ts` had
existed since Phase 1: the law was really waiting on the *published* surface, the one
RTAP hands to another system, which is exactly SARIF — the OASIS format GitHub code
scanning ingests. This builds it and flips the law honestly, because the thing the law
was waiting for now exists.

- `src/pipeline/sarif.ts` (NEW) — `buildSarifReport(input, options?)` renders a valid
  SARIF 2.1.0 log from the same `ReportInput` the other two renderers take, so all
  three describe one run identically (coverage is computed once, through
  `buildJsonReport()`, never recomputed differently). A result targets a
  `logicalLocation` (`target:<targetId>`), never a `physicalLocation` with a file URI:
  an RTAP Target is an LLM endpoint or agent, not a source file, and a `path:line`
  location would be a fabrication. Evidence reaches SARIF only as an `EvidenceRef` — a
  `{ref, kind}` object in `result.properties.evidenceRefs` and an opaque
  `rtap-artifact:<ref>` URI in `relatedLocations` — never the raw payload, response, or
  trace bytes. The guarantee is structural, not a filter: `ReportInput` has no field
  through which a payload *could* enter. Verdict → level maps VULNERABLE to
  `error`/`warning` by severity, RESISTANT to `none`, UNVERIFIED/ERROR to `note`; an
  incomplete-coverage run is marked `executionSuccessful=false`, the same refusal
  `buildAssessmentReport()` makes, in SARIF's own vocabulary. `partialFingerprints`
  are verdict-independent per `(target, probe)` so a VULNERABLE→RESISTANT transition
  reads as one result changing state, not one closing and another opening.
- `src/pipeline/correlate.ts` — `ObservationLike` gains an optional
  `evidenceRefs?: readonly ArtifactRef[]`, the sole channel through which evidence
  reaches a report. Shape reuses `ArtifactRef` from the Protected Artifact Store so the
  two never diverge. Backward-compatible: every existing caller omits it, and
  `buildJsonReport()`/`buildMarkdownReport()` output is byte-for-byte unchanged.
- `src/pipeline/report-cli.ts` (NEW), `npm run report` — the production caller the
  report builders never had. `tsx src/pipeline/report-cli.ts --db=... --assessment-run-id=...
  [--format=json|markdown|sarif] [--out=path] [--coverage-scheduled=N
  --coverage-unresolved=KEY ...] [--tool-version=X] [--information-uri=URL]`. Reads one
  run's committed Observations via `ObservationStore.listByAssessmentRun()`, correlates
  Findings, renders the chosen surface to stdout or a file. Coverage is honest by
  construction: absent `--coverage-scheduled`, the report is UNKNOWN (SARIF
  `executionSuccessful=false`) rather than silently presented as complete, and the
  process exits `2` when `buildAssessmentReport()` refuses — a CI step that renders a
  report also learns the run refused, without re-parsing it.
- `redteam.artifact/public-report-never-inlines-payload` — `pending` → `implemented`,
  200 seeded trials. Over random Observations whose bytes live behind a
  content-addressed ref (a secret payload attached to no report field), none of the
  three renderers serializes that payload, and the SARIF surface still references every
  ref — non-vacuous, because a renderer that silently dropped refs would pass "no
  payload" trivially. **94 laws total, 90 implemented (90 held, 0 failed), 4 pending**
  — the first pending law to become implemented since the count reached 89, and the
  four that remain are each blocked on something genuinely external (two Rust-side
  frozen invariants, a durable RunStep engine, a live KMS endpoint), unchanged.
- Verified end to end, not just in unit isolation: seeded a real file database with two
  Observations carrying real `evidenceRefs`, ran `npm run report --format=sarif` and
  confirmed a valid 2.1.0 log with `rtap.probe.jailbreak` at level `error`, evidence as
  `rtap-artifact:sha256:...` related locations, and `executionSuccessful=true` once
  `--coverage-scheduled=2` established completeness — then confirmed the same run
  without coverage reports UNKNOWN and exits `2`. Tests: `test/sarif.test.ts` (10) and
  `test/report-cli-path.test.ts` (the store→SARIF data path) alongside the existing
  `test/report.test.ts`.

**What's honestly not here**: this CLI does not itself derive coverage from the
CampaignWorld — computing `scheduledUnresolved` means an event-store replay the report
layer deliberately does not own, so the operator (or a Phase-5 caller that already holds
the world) supplies it. `informationUri` is omitted by default rather than pointing at a
URL that resolves to nothing; RTAP has no canonical public URL yet.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run laws            # prints the full law report, exit 1 on any failed law
npm run laws -- --seed=42
npm run report -- --db=rtap.db --assessment-run-id=run-1 --format=sarif   # JSON/Markdown/SARIF
```
