# Concurrency correctness: invariants and fuzzer

This document is the Part A/Part B artifact for the fix to two concurrency
bugs:

- **Bug A** — `CoalescingOracle.getScore` could leak an unhandled promise
  rejection (Node `unhandledRejection`, `process.exitCode = 1` by default;
  fatal inside a Manifest V3 service worker).
- **Bug B** — `CircuitBreakerOracle.getScore` had an unsynchronized
  check-then-act on `state`/`nextAttempt`: every concurrent caller arriving
  once the cooldown elapsed was routed straight to the real downstream
  ("thundering herd"), and whichever probe settled last won the race on
  `state`/`failures`, so a late success could silently erase an earlier
  probe's failure.

The full written invariant argument (Part A) lives as a doc comment directly
on each fixed class, since that is what stays in sync with the code:

- `src/CircuitBreakerOracle.ts` — INV1 (single probe / no thundering herd),
  INV2 (deterministic settlement / failure dominance), INV3
  (linearizability: some sequential ordering of real downstream calls
  explains the final state).
- `src/CoalescingOracle.ts` — INV (no unhandled rejection for any
  success/failure pattern).

This document covers Part B: how `tests/concurrency/scheduler.ts` turns
those prose invariants into a randomized, PCT-style schedule fuzzer with a
formal probabilistic bug-finding guarantee, and how the iteration budgets
used in `tests/concurrency/*.fuzz.test.ts` were chosen.

## From OS-thread PCT to promise/microtask scheduling

PCT (Burckhardt, Kothari, Musuvathi, Nagarakatte, ASPLOS 2010) schedules `k`
threads over `n` scheduling events by assigning each thread a distinct random
priority and inserting `d - 1` random _priority-change points_: at each one,
the currently-running thread is demoted below every other runnable thread,
forcing a different one to run next. Its headline result is a lower bound on
the probability that a single random run exposes a bug of "depth" `d` (the
number of specific ordering decisions required to trigger it):

```
P(exposing a depth-d bug in one run) >= 1 / (n * k^(d-1))
```

This codebase has no OS threads or preemption, so the adaptation keeps the
_mechanism_ (random priorities + random change points forcing specific,
deep interleavings instead of relying on whatever order things happen to
settle in) and re-targets it at the two knobs this concurrency model
actually exposes:

- **Settlement order** of manually-controlled deferreds — the direct
  analogue of "which thread runs next", since settling a deferred is what
  lets that caller's continuation (and its synchronous state mutations) run.
- **Microtask tick count** between settlements — fuzzes how many pending
  `.then` continuations from _other_ callers drain before/after a given
  settlement; this has no OS-thread analogue (OS schedulers don't have a
  microtask queue) but costs nothing extra to randomize once we're already
  controlling settlement order.

`generateSchedule(seed, opts)` in `tests/concurrency/scheduler.ts` assigns
each of `numCallers` "tasks" a distinct random priority and picks
`min(targetDepth - 1, numCallers - 1)` random change points among the
settlement events, exactly mirroring PCT's `k` and `d - 1`. Everything is
derived from a seeded PRNG (`mulberry32`), so a `Schedule` is fully
determined by `(seed, opts)` — the same seed always reproduces the identical
schedule, satisfying the "deterministic given a fixed seed" requirement even
though the space of schedules explored across seeds is effectively
unbounded (`seed` ranges over all 32-bit integers, and for a given seed the
generator can be re-parameterized to widen `numCallers`/`targetDepth`
further).

## Choosing the iteration budget

Bug B, as originally written, requires a schedule where: (1) a caller's
admission sees the cooldown elapsed and starts a probe, (2) _another_
caller's admission also reaches the downstream (the thundering-herd defect
itself — no synchronization prevented it), and (3) that second call's
settlement (a success) is ordered _after_ an earlier one's settlement (a
failure), so the success's `reset()` overwrites the failure's `OPEN` state
instead of the failure winning. That is a depth `d = 3` bug in PCT's sense.

Parameters used for the main fuzz runs (`tests/concurrency/*.fuzz.test.ts`):

- `n = 5` (`maxCallers`) — enough concurrent callers to exhibit the herd.
- `k = n = 5` — one priority per task.
- `d = 3` (`targetDepth`).

```
p_min = 1 / (n * k^(d-1)) = 1 / (5 * 5^2) = 1 / 125 = 0.008
```

For a target confidence `C` of finding at least one bug-exposing schedule
_if the bug is present_, the number of independent iterations `N` needed
solves `(1 - p_min)^N <= 1 - C`:

```
N >= ln(1 - C) / ln(1 - p_min)
```

For `C = 0.9999` (99.99%): `N >= ln(0.0001) / ln(0.992) ≈ -9.210 / -0.00803 ≈ 1147`.

The fuzz suite runs **2000** iterations per scenario (fixed implementation,
buggy implementation, and each composition order) — comfortably above the
1147 required for 99.99% confidence at this `(n, k, d)`, while still running
in well under a second per scenario since each iteration is pure
promise/microtask scheduling with fake timers (no real waiting). The
bug-catching test (reintroduced buggy `CircuitBreakerOracle`/
`CoalescingOracle`) is expected to find a violation well inside this budget;
if it didn't, that would itself be a sign the fuzzer isn't exercising the
right depth and is reported as a failing test rather than silently trusted.

## What "catching the bug" and "shrinking" mean here, concretely

- `tests/concurrency/circuitBreaker.fuzz.test.ts` runs the fixed
  `CircuitBreakerOracle` for 2000 seeds and asserts zero INV1/INV2/INV3
  violations, then runs the _same_ fuzzer against a local, test-only
  `BuggyCircuitBreakerOracle` (the pre-fix check-then-act logic) and asserts
  it finds a violation within the same 2000-seed budget.
- `tests/concurrency/coalescingOracle.fuzz.test.ts` installs a real
  `process.on('unhandledRejection', ...)` listener, runs the fixed
  `CoalescingOracle` for 2000 seeds asserting zero unhandled rejections, then
  runs the same fuzzer against a local, test-only `BuggyCoalescingOracle`
  (the exact pre-fix `p.catch(err => { ...; throw err; })` code from commit
  `f8290eb`'s parent) and asserts an unhandled rejection _is_ observed.
- `tests/concurrency/composition.fuzz.test.ts` runs the same invariant
  checks against `CircuitBreakerOracle` and `CoalescingOracle` stacked in
  both orders (and with `FallbackOracle`), for 2000 seeds each.
- Whichever of the above finds a violating seed feeds it to
  `shrinkSchedule` (delta-debugging over caller count, change-point count,
  and tick counts — see the termination-guarantee note on `shrinkSchedule`
  in `tests/concurrency/scheduler.ts`), and the test asserts the shrunk
  schedule is strictly smaller than the original and still reproduces the
  same invariant violation.
