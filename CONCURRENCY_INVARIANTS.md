# Concurrency invariants: `CircuitBreakerOracle` and `CoalescingOracle`

This document is the Part A correctness argument required by the issue
fixing the HALF_OPEN thundering-herd race in `CircuitBreakerOracle` and the
unhandled-rejection leak in `CoalescingOracle`. It states, precisely enough
to translate 1:1 into runtime assertions, the invariants both classes must
maintain under arbitrary concurrent interleaving of `getScore` calls and of
the settlement order of the underlying oracle's promises.

The fuzzer in `tests/fuzz/` checks exactly these invariants — see
`tests/fuzz/invariants.ts`, where each function is named after the
`INV-*` id below and its docstring quotes the corresponding paragraph here.

## 1. Concurrency model

Both classes run under Node's single-threaded, run-to-completion event loop.
There is no real parallelism; "concurrency" here means: multiple logical
`getScore` calls whose synchronous prefixes and `.then`/`await` resumptions
are _interleaved_ by the microtask/macrotask scheduler, because each call
awaits a promise (the underlying oracle's call) that some other party
(a test harness, or in production, real I/O) resolves at an unpredictable
time relative to other calls.

We model a concurrent run as a **schedule**: a sequence of atomic _steps_,
where a step is one of:

- **Launch(c, dest)** — caller `c` synchronously begins `getScore(dest)`,
  running until its first `await` (or return).
- **Settle(id, outcome)** — the underlying oracle's `id`-th pending call is
  resolved or rejected, which schedules the resumption of whatever `.then`
  chains are attached to it as one or more subsequent microtasks.
- **Drain** — run the microtask queue to quiescence (no step interleaves
  _inside_ this; it is what actually executes the `.then` continuations
  scheduled by a prior `Settle`, and it is where a resumed `getScore` body
  runs until its next `await` or return).

A schedule is _legal_ if every `Settle` targets a call that exists and is
still pending at that point, and every call is eventually settled. Because
steps other than `Drain` are synchronous, run-to-completion guarantees that
two `Launch`/`Settle` steps never interleave _with each other_ — only the
_order_ the fuzzer picks for them is the source of nondeterminism being
tested. This is the JS analogue of PCT's OS-thread preemption points: our
"preemption points" are exactly the places where control returns to the
event loop, i.e. between one step and the next.

## 2. `CircuitBreakerOracle` invariants

State: `state ∈ {CLOSED, OPEN, HALF_OPEN}`, `failures: ℕ`,
`nextAttempt: timestamp`, `halfOpenProbe: Promise<number> | null`.

### INV-CB-1 — Single-flight probe

> At every point in time, `this.oracle.getScore` has been called on behalf
> of a HALF_OPEN probe **at most once** since the most recent OPEN→HALF_OPEN
> transition, and that call's promise is exactly `halfOpenProbe` while
> `state === HALF_OPEN`.

Machine-checkable form: instrument the underlying oracle to count calls
made while `state === HALF_OPEN` was true at call time; across any schedule,
that count is `≤ 1` per HALF_OPEN "generation" (per OPEN→HALF_OPEN
transition). Equivalently: `state === HALF_OPEN ⇒ halfOpenProbe ≠ null`, and
`halfOpenProbe` is reassigned only inside the code path that also performs
the `OPEN → HALF_OPEN` mutation.

### INV-CB-2 — Atomic transition

> The predicate "`state === OPEN ∧ Date.now() ≥ nextAttempt`" is checked and
> acted upon (transition to HALF_OPEN, launch the probe) with **no
> intervening `await`**. Consequently, for any set of calls whose `Launch`
> steps are scheduled back-to-back with no `Drain` between them, at most one
> call's synchronous prefix observes the predicate as true and performs the
> transition.

This is not an assumption to be tested probabilistically — it is a static
property of the source (`git grep -n await src/CircuitBreakerOracle.ts`
shows every `await` is either (a) inside `runProbe`'s try-block, reached
only by the single caller that just performed the transition, or (b) inside
the `HALF_OPEN` waiting branch, which does not touch `state`/`nextAttempt`
itself). The fuzzer still exercises it at runtime (INV-CB-1's counter is the
dynamic witness) because the argument depends on no future edit
accidentally inserting an `await` before the mutation.

### INV-CB-3 — Deterministic settlement / failure-dominance

> After any set of concurrent `getScore` calls has fully settled, the
> resulting `state` is determined solely by the outcome of the most recent
> probe (if any HALF_OPEN cycle occurred) or by the sequence of CLOSED-path
> failures/successes — never by which of several _simultaneously in-flight_
> probes happened to resolve last.

This subsumes the issue's literal requirement ("a failure always wins over
a concurrently-resolving success"): because INV-CB-1 guarantees there is
only ever one probe outcome to apply, there is no second, independently
racing success that could ever overwrite it. The bug this replaces is
precisely a violation of INV-CB-1 (multiple simultaneous probes), so
INV-CB-3 is proved _by_ INV-CB-1 rather than needing independent
synchronization. The fuzzer still checks it directly (as a trace assertion:
"if any probe in this schedule failed, the final state after all calls
settle is never CLOSED with `failures === 0` as if only successes had been
observed") so a regression that weakens INV-CB-1 without breaking its
counter check is still caught.

### INV-CB-4 — Per-destination result correctness (linearizability)

> For every call `getScore(dest)` that returns a score `v` (not an error),
> there exists a _real_ invocation of `this.oracle.getScore(dest)` — with
> that same `dest` — that also returned `v`. No caller ever observes a score
> that was actually produced for a different destination.

This is the linearizability-style requirement: pick, for each of the N
concurrent calls, a "real" underlying call it is attributable to (the
probe it launched itself, or the CLOSED-path call it made itself, or — for
a HALF_OPEN late-arrival — the call it makes _after_ recursing once the
probe settles). The mapping from `getScore(dest)` call to attributed
underlying call, together with the final `state`, must be consistent with
_some_ sequential (one-at-a-time) execution of those N calls against the
same breaker: i.e. you can order the N calls on a timeline such that
replaying them one at a time, synchronously, against a fresh breaker in
that order reproduces the same sequence of state transitions and the same
per-call results. Concretely the implementation guarantees this by never
resolving a caller's promise with another destination's score (see
`docs`-adjacent comment `INV-CB-4` in `src/CircuitBreakerOracle.ts`): a
late arrival during HALF_OPEN always issues its _own_ call once the probe's
outcome is known, rather than reusing the probe's resolved value.

### Design choice this document commits to (per the issue's "pick one")

Concurrent callers that arrive **while a HALF_OPEN probe is in flight**
_coalesce on the probe's outcome_, not its value: they wait for the probe to
settle (success or failure), let it drive the state transition, and then
re-issue their own call against the resulting state (CLOSED ⇒ real call,
OPEN ⇒ fail-fast/fallback). Pure "fail fast during an active probe" was
rejected because it would fail every caller stacked behind a slow-but-
eventually-successful probe for no reason; pure "coalesce on the _value_"
was rejected because the breaker's state (and hence `halfOpenProbe`) is
global across destinations — reusing the probe's resolved value would hand
one destination's score to a caller asking about a different destination,
which is a correctness bug INV-CB-4 exists to rule out.

## 3. `CoalescingOracle` invariants

### INV-CO-1 — No floating rejection

> For every promise `p` this class obtains from `this.inner.getScore`, at
> least one rejection-observing reaction (`.then(_, onRejected)`, `.catch`,
> or `await`) is attached to `p` **itself**, synchronously, before control
> returns to the event loop after `p` is created. Every promise _derived_
> from `p` (e.g. the return value of a `.then`/`.catch` call) that could
> reject must itself have such a reaction attached, transitively, with no
> derived promise left unobserved.

This is a direct translation of Node's `unhandledRejection` semantics: a
promise fires that event iff it rejects and, by the time the job queue that
settled it has fully drained, it still has zero attached rejection
handlers. INV-CO-1 is exactly "this never happens for any promise this
class creates." The canonical counterexample the issue names —
`p.catch(err => { log(err); throw err; })` called for effect and discarded
— violates INV-CO-1 because the _returned_ promise from `.catch(...)`
(which rejects, since the handler rethrows) is never itself given a
handler.

Machine-checkable form: the fuzzer installs a real
`process.on('unhandledRejection', ...)` listener for the duration of each
schedule and asserts it never fires, for every success/failure pattern and
every settlement order explored.

### INV-CO-2 — Single underlying call per destination

> While an entry for `dest` is present in `inFlightByDestination`, at most
> one call to `this.inner.getScore(dest)` is outstanding, and every
> `getScore(dest)` call issued during that window resolves/rejects with
> exactly the same value/error (by reference, for errors) as that one call.

This is the de-duplication contract the class exists to provide, restated
as an invariant so the fuzzer can check it isn't broken by whatever change
fixes INV-CO-1 (e.g. by refactoring the `.finally`/`.catch` bookkeeping
chain in a way that races the map cleanup against a new caller).

## 4. Composition

`CircuitBreakerOracle`, `CoalescingOracle`, and `FallbackOracle` are meant
to be stacked (`OracleMiddleware.ts`, "Composing cross-cutting concerns").
Composition does not introduce new state shared _between_ the wrappers —
each wrapper only touches its own private fields — so the invariants above
continue to hold independently of composition order, **provided** each
wrapper still only ever calls `next.getScore` in a way the inner wrapper's
own invariants tolerate (e.g. `CircuitBreakerOracle` wrapping
`CoalescingOracle` calls `next.getScore(dest)` from at most one concurrent
"logical" path at a time per INV-CB-1, which `CoalescingOracle` handles
correctly for any number of concurrent callers per INV-CO-2; conversely
`CoalescingOracle` wrapping `CircuitBreakerOracle` may call
`next.getScore(dest)` many times concurrently for _different_ destinations,
each of which is a normal concurrent caller from `CircuitBreakerOracle`'s
point of view). The fuzzer runs both orders explicitly (Part B, acceptance
criterion 2) rather than relying on this argument alone, because the
argument's "provided" clause is exactly the kind of thing a future edit to
either class could invalidate silently.

## 5. What "invariant violation" means for the fuzzer

For a single generated schedule, a run is a **failure** iff, at any point
during or after executing the schedule to completion:

- `INV-CB-1` — the instrumented underlying-oracle call counter records more
  than one call attributed to the same HALF_OPEN generation, OR
  `state === HALF_OPEN ∧ halfOpenProbe === null` is observed, OR
  `state !== HALF_OPEN ∧ halfOpenProbe !== null` is observed after the
  schedule's final `Drain`.
- `INV-CB-3` — the schedule contains a probe failure and the final state
  after all calls settle is `CLOSED` with `failures === 0` (the "a late
  success erased an earlier failure" signature from the original bug).
- `INV-CB-4` — any call that resolved successfully with score `v` for
  destination `dest` cannot be matched to a real `Settle(id, {ok:true,
value:v})` step whose call was originally `Launch`ed via
  `oracle.getScore(dest)` with that same `dest`.
- `INV-CO-1` — the process-level `unhandledRejection` listener fired during
  the schedule.
- `INV-CO-2` — while an in-flight entry existed for `dest`, more than one
  call to the inner oracle for `dest` was observed, or two coalesced callers
  for the same window observed different resolved values/error references.

Any one of these is recorded as the failing schedule handed to the shrinker
(`tests/fuzz/shrink.ts`).
