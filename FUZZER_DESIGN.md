# PCT-style concurrency fuzzer: design and justification

This is the Part B artifact: how `tests/fuzz/` explores the schedule space
for `CircuitBreakerOracle` and `CoalescingOracle`, why the sampling strategy
is not uniform-random, how many iterations are run and why, and how
shrinking terminates. The invariants it checks are defined in
`CONCURRENCY_INVARIANTS.md`; this document is about the search
strategy over schedules, not the correctness argument itself.

## 1. Why not exhaustive enumeration

For `k` concurrent callers, the space of distinct interleavings of their
launch/settle events grows combinatorially — with `2k` orderable events
(one launch, one settlement, per caller, ignoring drains and any
second-wave calls) there are up to `(2k)!` orderings before even accounting
for outcome patterns (success/infra-fail/logic-fail per caller) or
destination assignment. At `k = 6` that is `12! ≈ 4.8×10^8` orderings for
_one_ fixed set of outcomes/destinations. Exhaustive enumeration is only
tractable for `k ≤ 3`, which is too small to reliably reproduce a bug that
needs several callers piled up during the same HALF_OPEN window. This is
exactly the motivation PCT (Burckhardt, Kothari, Musuvathi, Nagarakatte,
_"A Randomized Scheduler with Probabilistic Guarantees of Finding Bugs"_,
ASPLOS 2010) starts from, for OS-thread interleavings.

## 2. The adaptation

PCT's mechanism: assign each of `k` threads an independent random priority;
pick `d-1` random "priority change points" (a specific point during
execution at which the currently-scheduled thread's priority is dropped to
the bottom); always run the highest-priority _runnable_ thread. The paper's
result is that this concentrates the scheduler's randomness on the `d`
points that (for a bug of "depth" `d`, i.e. one that needs `d` specific
scheduling decisions to go a particular way) actually matter, instead of
diluting it uniformly over all `n` steps of the whole execution — which is
what gives PCT a bound on the probability of finding a depth-`d` bug that
is polynomial in `k`, `n`, `d` rather than needing to guess one specific
interleaving out of a combinatorial explosion.

There are no OS threads or preemption here. `tests/fuzz/schedule.ts`
translates the same mechanism onto this codebase's actual scheduling
points:

- **"Threads" → callers.** Each of the `k` concurrent `getScore` calls in a
  generated schedule is a schedulable entity, exactly as a PCT thread is.
- **"Steps" → abstract launch/settle tokens.** Each caller contributes
  exactly two abstract events: `launch(i)` (the caller begins) and
  `settle(i)` (the caller's own first underlying call resolves/rejects).
  `settle(i)` only becomes eligible once `launch(i)` has run — the direct
  analogue of a thread step only being runnable once the thread exists.
- **Random priorities.** `abstractOrder()` (`tests/fuzz/schedule.ts`)
  assigns each caller an independent random priority via the seeded RNG,
  exactly as PCT assigns each thread a random priority.
- **Priority change points → `ChangePoint`.** A `ChangePoint` names a step
  index and a caller; when the greedy scheduler reaches that step index, it
  demotes that caller to the lowest priority for the remainder of the run,
  exactly mirroring PCT's preemption-and-demote mechanism, translated from
  "the OS preempts this thread" to "this caller's launch/settle is
  deprioritized relative to the rest."
- **`depth` config = PCT's `d`.** The number of change points generated per
  schedule (`GenerateOptions.depth`) is the same knob as PCT's target bug
  depth: more change points bias exploration toward interleavings that
  require more distinct scheduling decisions to go a specific way.
- **Drains as the "no thread runs" gap.** `drainProbability` randomly
  inserts a full microtask-queue drain between two abstract steps — this
  models the possibility that, in the real system, other microtask/macrotask
  activity intervenes between two scheduling decisions, which is this
  runtime's equivalent of "control returns to the OS scheduler between
  preemption points."

What is _not_ claimed: this does not re-derive or reprove PCT's exact
probability bound (`Pr[find bug of depth d] ≥ 1/(k·n^(d-1)·d)`-shaped, in
the paper's OS-thread model) for this different event model — the paper's
proof is specific to their scheduler abstraction and constants. What _is_
claimed, and is real, elementary probability: if a single fuzzer iteration
has _some_ fixed lower-bound probability `p > 0` of reproducing a specific
bug (which the priority+change-point structure above is designed to make
non-negligible for shallow bugs, by concentrating randomness on the handful
of decisions that matter instead of spreading it over the whole schedule),
then running `T` independent iterations finds it with probability at least
`1 - (1 - p)^T ≥ 1 - e^{-pT}`. Section 3 uses this amplification bound to
justify the iteration counts actually run.

## 3. Iteration budget

The empirical baseline (see `tests/fuzz.selfcheck.test.ts`) is that the
_original_ HALF_OPEN thundering-herd bug is depth-1: it manifests whenever
two callers' `launch` events land back-to-back with no drain between them
while `state === OPEN` and the cooldown has elapsed — i.e. it needs exactly
one scheduling decision ("do two launches land in the same synchronous
burst") to go the adversarial way, not a rare, deep combination. Against
`BuggyCircuitBreakerOracle`, a run of `iterations: 200` with `depth: 1,
minCallers: 2` finds a violation essentially every time in practice (this
is asserted directly, not just claimed — see the self-check test), which is
consistent with a depth-1 bug having a large per-iteration `p`.

For the **fixed** implementation, there is (by construction, per
`CONCURRENCY_INVARIANTS.md`) no known bug left to find, so the
iteration count is chosen to make a _negative_ result (zero violations)
meaningful rather than to hit a specific depth target:

- `minCallers: 2, maxCallers: 6`, `depth: 2` (two change points — biasing
  toward interleavings that require two coordinated scheduling decisions,
  one level deeper than the original bug, as a margin of safety against
  subtler regressions).
- **5,000 iterations** for `CircuitBreakerOracle` alone and **5,000** for
  `CoalescingOracle` alone.
- **2,000 iterations per composition order** (`cb-outer-co-inner` and
  `co-outer-cb-inner`), 4,000 total — smaller than the standalone budgets
  only because each iteration additionally exercises both invariant sets at
  once (INV-CB-* and INV-CO-*), so a bug in either surface has two
  independent chances per iteration to be caught by _some_ check, and
  because composed schedules are run for both orders, doubling the
  effective coverage of the composition-specific INV-CB-4 cross-destination
  check relative to a single-order budget of the same size.

Total: **16,000 iterations** across the four suites, each seeded
independently and deterministically (see section 4). At depth 1 this is
`T = 16{,}000` against a per-iteration probability the self-check run
already shows is not small (empirically close to 1 for the _specific_ bug
this issue is about); even under a much more pessimistic assumption of
`p = 1/50` per iteration for some hypothetical subtler depth-2 regression,
`1 - (1 - 1/50)^{5000} ≈ 1 - e^{-100}`, i.e. indistinguishable from
certainty. The budget is intentionally generous relative to what depth-1/2
bugs need, because each iteration is pure in-memory microtask scheduling
(no real I/O, no timers) and the full 16,000-iteration run completes in a
few seconds — there is no practical reason to under-run it.

## 4. Determinism

`ScheduleSpec` (seed, callers, change points, drain probability) is a plain
serializable object; `planSchedule()` is a pure function of it — no
`Math.random()`, no wall-clock reads (`cooldownWindow: 0` sidesteps the
need to fake `Date.now()`), and no reliance on real timers anywhere in
`tests/fuzz/`. `runFuzzer()` derives every generated spec from a single
seeded `mulberry32` stream, so a fixed `config.seed` reproduces the exact
same sequence of specs, and each spec reproduces the exact same concrete
schedule. A failure discovered in CI is therefore always locally
reproducible from the seed and iteration index alone.

## 5. Shrinking

`tests/fuzz/shrink.ts` implements delta-debugging-style minimization
directly on `ScheduleSpec`, not on the low-level action list, because the
compact spec (caller count, per-caller outcome, change points, drain
probability) is what actually determines schedule complexity — shrinking
the spec automatically shrinks the derived concrete schedule.

Each round tries, in order: dropping one caller, dropping one change point,
zeroing the drain probability, and simplifying one caller's outcome to
`'success'` — keeping the first change that still reproduces the _same_
invariant id (not just _any_ violation, so shrinking can't wander into a
different bug). See the docstring on `shrinkSchedule` for the termination
argument: `scheduleSize` is a bounded non-negative integer that strictly
decreases on every accepted reduction, each round's candidate list is
finite and bounded by the spec's current size, so the algorithm is
guaranteed to reach a fixed point — it cannot shrink forever, and does so
in at worst O(n²) reproduction runs for an initial size-`n` spec.

`tests/fuzz.selfcheck.test.ts` demonstrates this end-to-end: it generates a
large failing schedule against `BuggyCircuitBreakerOracle` (many callers,
several change points), confirms the fuzzer flags it, then shrinks it and
asserts the result is strictly smaller (fewer callers and/or fewer change
points) while still reproducing the exact same `INV-CB-1` violation.
