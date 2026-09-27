# RTAP Execution Safety Runbook

Three independent manual-intervention procedures, all for situations the platform
deliberately refuses to resolve on its own rather than guess: **Part A**,
`UNKNOWN_EFFECT_OUTCOME` (an effect whose real-world outcome can't be proven either
way); **Part B**, a leaked `ConcurrencyReservation` (a scheduler barrier that
outlived the attempt that created it); and **Part C**, a `RunStep` waiting on a human
`ASK` decision (`admitDispatch()`'s optional `ApprovalGate`, грань №12). Every step in
all three parts refers to real, shipped code — `src/execution/` — there is no step
here that isn't backed by a function you can call directly.

## Part A — Resolving `UNKNOWN_EFFECT_OUTCOME`

EXECUTION_SAFETY_RECOVERY.md §15 admission criterion 13, and the closing line of
§15 itself: "RTAP prevents duplicate canonical commit, fences stale execution
owners, and never repeats an ambiguous external effect without a capability-backed
recovery decision." `UNKNOWN_EFFECT_OUTCOME` is what that guarantee produces when
neither a receipt nor a query can resolve what actually happened externally — it is
a **durable business outcome**, not a transient error, and §6 is explicit that it
must never be auto-retried. This part is what an operator does with one.

### A.1. Find every `UNKNOWN_EFFECT_OUTCOME`

```ts
const attempts = new ExecutionAttemptStore(db, runSteps);
attempts.listByRunStep(runStepId).filter(a => a.terminalReason === 'UNKNOWN_EFFECT_OUTCOME');
```

Each one is an `ExecutionAttempt` that was reconciled (`EffectReconciler.reconcile()`,
4.5.2) but whose underlying effect could not be proven to have happened or not.
`redteam.execution/unknown-effect-is-not-auto-retried` guarantees the platform
itself never silently retried it — it is sitting there waiting for a decision, not
lost.

### A.2. Read what's actually known

```ts
const receipt = receipts.getByExecutionAttempt(attempt.executionAttemptId);
```

- **No receipt at all**: the crash happened before the local `EFFECT_STARTED`
  write (§13's first row). Nothing external is known — proceed to A.3 as if the
  outcome is fully ambiguous.
- **Receipt with `outcome: 'UNKNOWN'`**: the effect was dispatched
  (`receipt.startedAt`) but never acknowledged, or acknowledged but couldn't be
  reconciled. Check `receipt.capability` — this tells you what recovery paths were
  even available (§6's table) at the time.
- **Receipt with `outcome: 'CONFIRMED'` or `'FAILED_BEFORE_EFFECT'`**: this should
  not reach `UNKNOWN_EFFECT_OUTCOME` at all —
  `EffectReconciler.reconcile()` short-circuits `CONFIRMED` straight to
  `PROCEED_TO_NATIVE_RESULT` and treats `FAILED_BEFORE_EFFECT` as proven-safe retry.
  If you find one of these paired with an `UNKNOWN_EFFECT_OUTCOME` terminal reason,
  that is a bug in the caller, not a normal operational state — stop and investigate
  the code path, don't apply this runbook's decision tree to it.

### A.3. Decide, using the same table `decideRecovery()` encodes (§6/§12)

This is a **manual application of an automatic decision procedure** —
`decideRecovery()` (`src/execution/reconciliation.ts`) already computed and applied
this; you are here because its answer was `UNKNOWN_EFFECT_OUTCOME`, which means none
of the automatic paths applied. Your job is to supply what the machine couldn't:
external, out-of-band evidence.

| What you can establish | Action |
|---|---|
| The target system's own logs/dashboard show the effect never happened | Safe to retry. Create a fresh `ExecutionAttempt` (new lease generation via `RunStepStore.lease()`, new `attempts.start()`) — never reuse the old, terminal one. |
| The target system's logs confirm the effect *did* happen, and its result is recoverable | Do **not** retry — that would duplicate the effect. Fetch the real result and commit it via `commitFencedObservation()` against a **new** attempt, with `nativeResultRef` pointing at the artifact you recovered. |
| The effect definitely happened, but you cannot recover its actual result | This is the case §12's `COMPENSATABLE` path exists for. If the operation has a defined compensation (documented per-adapter, per-`operationFamily` — not built generically here), run it by hand and record that you did, e.g. as an `execution_quarantine`-style note. If no compensation exists, the effect's consequence is now outside RTAP's tracked state — escalate to whoever owns the target system. |
| You cannot establish anything | Leave the attempt terminal as `UNKNOWN_EFFECT_OUTCOME`. This is a valid, final state — §6: "a durable business outcome... not a transient exception." Do not force a retry just to clear it. |

### A.4. What NOT to do

- **Never** call `attempts.bindNativeResult()` against the old, terminal attempt to
  "revive" it — `ATTEMPT_ALREADY_TERMINAL` will reject it, correctly. Terminal means
  terminal.
- **Never** hand-edit `execution_attempts.terminal_reason` in the database to make
  it look resolved. The row is the audit trail; falsifying it defeats the entire
  point of this gate.
- **Never** treat "I couldn't find evidence either way" as license to guess
  `CONFIRMED` or `FAILED_BEFORE_EFFECT`. Guessing is exactly what
  `AT_MOST_ONCE_UNPROVEN`/`UNKNOWN_EFFECT_OUTCOME` exists to prevent — if you
  genuinely don't know, the honest terminal state is the one already there.

### A.5. Related quarantine records

A **late result** (a native result arriving for an attempt that's since been
superseded by a new lease generation, or is already terminal) is a different, more
common situation than `UNKNOWN_EFFECT_OUTCOME` — it's automatically quarantined,
not left ambiguous:

```ts
attempts.quarantineHistory(runStepId); // every rejected bind attempt, with a FencingRejectionReason
```

If you see `STALE_LEASE_RESULT` here, that's the system working correctly (§7) —
the current attempt already has (or will have) its own result; the quarantined one
is informational, not something to act on unless you're investigating *why* a
worker's lease expired in the first place (usually: it was slower than
`leaseDurationMs`, or it crashed).

## Part B — Releasing a retained `ConcurrencyReservation`

`admitDispatch()` (`src/execution/dispatch.ts`) is the only place
`ConcurrencyScheduler.reserve()` is called from the real dispatch path, and
`settleAttempt()` (`src/execution/settle.ts`) is the only place that disposes of what
it acquired. `settleAttempt()` releases the barrier for **every** terminal reason
except one:

> `UNKNOWN_EFFECT_OUTCOME` **retains** its barrier, deliberately.

That is the entire scope of this part. §6 calls that outcome "a durable business
outcome," and the effect it describes may still be genuinely in flight — releasing
the target would permit exactly the double-dispatch `TARGET_SERIAL`/
`CAMPAIGN_SERIAL`/`EXCLUSIVE` exist to prevent. So the barrier is held until a human
establishes what actually happened (Part A) and then releases it explicitly (below).
`ConcurrencyScheduler` never releases on a lease timing out either (§9: "released
only after terminal resolution or an explicit recovery takeover... an expired worker
lease does not automatically release the external resource"), so nothing will clear
it on your behalf.

**Historical note, if you are reading an older database.** Before
`settleAttempt()` existed, `release()` had exactly one caller —
`commitFencedObservation()`'s success path, and only when the caller remembered to
pass a guard. Every other terminal path (a reconciled attempt, a fencing rejection, a
cancellation, an adapter throwing) stranded its reservation. Rows from that era can
therefore be held by attempts terminal for *any* reason, not just
`UNKNOWN_EFFECT_OUTCOME`. B.1 finds both populations; B.2 tells them apart.

### B.1. Find reservations still held by a terminal attempt

```ts
const scheduler = new ConcurrencyScheduler(db);
const attempts = new ExecutionAttemptStore(db, runSteps);

const held = scheduler
  .activeReservations() // released_at IS NULL — every reservation currently held
  .filter((r) => attempts.get(r.executionAttemptId)?.terminalReason != null);
```

A still-active, non-terminal attempt holding its reservation is not a leak — that is
the barrier doing its job. Everything this query returns falls into one of exactly
two cases, separated in B.2: a deliberate `UNKNOWN_EFFECT_OUTCOME` retention (expected;
resolve via Part A, then release here), or a pre-`settleAttempt()` leftover (release
directly).

### B.2. Check whether the underlying attempt still needs Part A first

If `attempts.get(reservation.executionAttemptId)!.terminalReason ===
'UNKNOWN_EFFECT_OUTCOME'`, **stop here and run Part A above to completion first.**
Releasing the reservation does not resolve the effect — it only frees the resource
for a *new*, unrelated reservation to be granted, which for `TARGET_SERIAL`/
`CAMPAIGN_SERIAL`/`EXCLUSIVE` means letting new work start against the same
target/campaign while the old effect's real-world outcome is still unproven. Only
release once Part A's decision tree has been applied and you're confident the old
effect is genuinely settled (proven-never-happened, recovered, compensated, or
deliberately left as a permanent `UNKNOWN_EFFECT_OUTCOME` with no further action
coming).

For every other terminal reason (`COMPLETED`, `FAILED_BEFORE_EFFECT`, `CANCELLED`,
`TIMED_OUT_BEFORE_EFFECT`, `AUTHORIZATION_DENIED`, `CAPABILITY_UNSUPPORTED`,
`NORMALIZATION_FAILED`, `STALE_LEASE_RESULT`, `OBSERVATION_COMMITTED`,
`TARGET_UNAVAILABLE`), the attempt is already fully resolved one way or another —
there is nothing further to reconcile, only the reservation itself to free. On
current code `settleAttempt()` has already freed it, so finding one of these still
held means either a pre-`settleAttempt()` row (see the historical note above) or a
terminalization that bypassed `settleAttempt()` — worth a quick look at *which* code
path produced it before you release, since the second case is a bug worth fixing at
the source rather than by hand here.

### B.3. Release it

```ts
scheduler.release(reservation.reservationId, new Date());
```

`release()` is a pure administrative unlock — a plain `UPDATE ... SET released_at
= @now WHERE reservation_id = @id AND released_at IS NULL`. It does not touch the
attempt, the effect, or any Observation; it only frees the resource key(s) for a
future `reserve()` call to succeed. Idempotent on an already-released row (the
`released_at IS NULL` guard makes a repeat call a no-op, not an error).

### B.4. What NOT to do

- **Never** release a reservation whose attempt is still `UNKNOWN_EFFECT_OUTCOME`
  without first applying Part A — doing so lets new work start on a
  target/campaign whose previous effect might still be genuinely in flight,
  which is exactly the double-dispatch `TARGET_SERIAL`/`CAMPAIGN_SERIAL`/
  `EXCLUSIVE` exist to prevent.
- **Never** treat a long-held, still-active (non-terminal) reservation as a leak
  and release it out from under a genuinely in-progress attempt — check
  `terminalReason` first; a `null` terminal reason means the attempt may still be
  legitimately running.
- **Never** delete or hand-edit `concurrency_reservations` rows directly. The row
  is the audit trail of who held the barrier and when; `release()` is the only
  sanctioned way to close one out.
- **Never** reach for `settleAttempt()` here. It settles an attempt *and* disposes of
  its barrier together, and it will throw on anything you find via B.1 — those
  attempts are already terminal, and attempts are immutable once terminal. Barrier
  disposal is bundled with settlement precisely so that no code path can settle
  without deciding the barrier's fate; that bundling is not a tool for re-deciding it
  afterward. `scheduler.release()` is the deliberate, operator-only unbundling.

## Part C — Resolving a `RunStep` stuck on `ASK`

грань №12's adaptation of "ask for approval" to RTAP's own architecture: the original
idea models an unresolved decision as an in-memory suspended `Promise`, which would
not survive a worker restart — every other mechanism in this repo goes out of its way
to guarantee that survival. Instead, `admitDispatch()`'s optional `ApprovalGate` reuses
the shape `CONCURRENCY` back-pressure already has: `requiresApproval()` (a pure,
synchronous predicate — no suspension anywhere) runs once authorization has already
cleared, and if it says yes, the call is refused *this attempt only*, writing **no
execution record**, exactly like back-pressure. The `RunStep` keeps whatever lease
state it already had and becomes re-leasable the normal way once that lease expires.
`PendingApprovalStore` (migration 5, `pending_approvals`, `run_step_id UNIQUE`) is
what makes the decision durable and idempotent: every re-lease of the same step sees
the *same* pending row (`get()` before `requestApproval()`), never a fresh one.

**Current deployment state, honestly**: `src/worker/promptfoo-worker.ts` calls
`executeLeasedStep()` without an `ApprovalGate` at all, so on the code as shipped today
`NO_APPROVAL_REQUIRED` is the only policy any real caller uses — nothing in production
will actually produce an `ASK`. This part exists for the day a deployment wires in its
own `ApprovalPolicy` (e.g. gating a `duo-llm` operation family, or a specific target),
not for current default operation. If you never see a row in `pending_approvals`, that
is expected, not a sign anything is broken.

### C.1. Find every `RunStep` awaiting approval

```ts
const approvals = new PendingApprovalStore(db);
approvals.listPending(); // decision IS NULL, ordered by requestedAt ascending
```

Each `PendingApproval` carries `runStepId`, `campaignId`, `assessmentRunId`, and
`operationFamily` — everything the request itself knew when it asked. There is
deliberately no `ExecutionAttempt` for this state: `ASK` writes no execution record,
so `execution_attempts` has nothing to show you. At the `RunStep` level alone, a step
waiting on approval is indistinguishable from one whose worker simply crashed
mid-lease — both sit as `LEASED`/`RUNNING` with an eventually-expired
`lease_expires_at`. Cross-referencing `pending_approvals` by `runStepId` is the only
way to tell them apart, the same "read what's actually known before deciding anything"
discipline as A.2.

### C.2. Decide

`ApprovalPolicy.requiresApproval()` is caller-defined — this runbook cannot prescribe
*what* should be approved, since that is a deployment-specific policy decision, not a
platform invariant. What it can tell you: the only context you have to reason with is
exactly what `C.1` returned (`campaignId`, `assessmentRunId`, `operationFamily`,
`requestedAt`) plus whatever out-of-band knowledge tells you why this operation family
was configured to require a human. There are exactly two valid outcomes —
`'APPROVED'` or `'DENIED'` — nothing in between, and no way to defer to "ask again
later" once you resolve.

### C.3. Resolve it — via the CLI, not by hand

```bash
tsx src/approval/cli.ts list --db=path/to/campaign.sqlite
tsx src/approval/cli.ts resolve --db=path/to/campaign.sqlite \
  --approval-id=<id> --decision=APPROVED --decided-by=<your-name>
```

`resolve()`'s own guard is `UPDATE ... WHERE decision IS NULL` — the same
conditional-write pattern `OutboxStore` and `ConcurrencyScheduler.release()` already
use. Two operators racing on the same `approvalId` (or one operator re-running the
command) can never both win: the loser gets back `ALREADY_DECIDED` with the decision
that actually landed and who made it, never a silent overwrite and never a false
success for a decision that didn't happen.

### C.4. What actually happens next — it is not instantaneous

Resolving an approval **only writes the `pending_approvals` row**. Nothing pushes the
outcome to the waiting `RunStep`; the step must be leased and driven through
`executeLeasedStep()` again — by whatever re-invokes `worker/`, since
`runPromptfooWorkerOnce()` drains the queue once and exits, it does not poll — before
`admitDispatch()` observes your decision:

- **`APPROVED`** → the next admission attempt falls through exactly as if no approval
  gate existed at all: normal concurrency reservation, a real `ExecutionAttempt`, real
  dispatch.
- **`DENIED`** → the next admission attempt writes a real, durable `ExecutionAttempt`
  terminalized `AUTHORIZATION_DENIED` (reason `POLICY_DENIED`, detail naming who
  denied it and the `approvalId`), and `executeLeasedStep()` fails the `RunStep` on
  the spot. This is the step's real terminal fate — there is no re-approving it
  afterward; `resolve()`'s own `WHERE decision IS NULL` guard means a decision, once
  made, cannot be changed. A step that should proceed after all needs a fresh
  dispatch, not a second resolution of the same approval.

### C.5. What NOT to do

- **Never** hand-edit `pending_approvals.decision`/`decided_by`/`decided_at` in the
  database. The row is the audit trail of who approved or denied what and when;
  `resolve()` is the only sanctioned way to write a decision.
- **Never** assume approving unsticks the step immediately. Nothing here reaches into
  a running or future worker invocation — see C.4. If nothing re-leases the step,
  `APPROVED` sits just as inertly in the database as `ASK` did.
- **Never** treat `DENIED` as reversible. There is no "undeny" — the guard that keeps
  two operators from racing to a decision applies just as much to one operator
  changing their mind. If the operation should still happen, that is a new dispatch
  against a new `RunStep`, not a mutation of this approval.
- **Never** wire a real `ApprovalPolicy` into production expecting this part to have
  been exercised end-to-end under load — it is real, tested code
  (`test/execution/approval-store.test.ts`, `test/execution/dispatch.test.ts`), but as
  of this writing no production caller has ever actually produced an `ASK` (see the
  note above C.1). Treat the first real approval in production as the first real test
  of this procedure, not a well-worn path.
