# Decision: eager fixture loading stays as-is (issue #29)

**Status:** closed as not-needed, pending re-evaluation if the trigger below is hit.

## Background

`StubOracle` eagerly imports `src/fixtures/testkit/scores.json` at module load
and does an O(1) object lookup per call (`src/StubOracle.ts`). #29 proposed
replacing this with a lazy `fs`/`fetch`-based loader with an on-demand index,
but was explicitly scoped to only proceed "if profiling data from #28
demonstrates the need," and to otherwise close with a documented rationale.
This document is that rationale, backed by real profiling numbers.

## What #28 produced

#28 ("Profile and optimize fixture loading/lookup for large fixture sets")
was closed by #63, which added
`tests/benchmarks/StubOracle.benchmark.test.ts`. The harness generates
synthetic fixture sets (10k / 50k / 100k / 200k entries), measures module
import time and heap delta for each via Node's ESM JSON import, and runs
50k lookups per size to measure average lookup latency. It has no hard
pass/fail assertions on those numbers — it logs a JSON summary via
`console.log` — but it *is* included in `tests/**/*.test.ts`
(`vitest.config.ts`), so it runs on every `npm test`, including in CI
(`.github/workflows/ci.yml` runs `npm test` on every push/PR). It has been
producing real numbers on every CI run since #63 merged; they just hadn't
been captured anywhere until now.

## Actual results

Pulled from a recent green CI run
(`gh run view 29987148365 --repo Gryd-lock/grydlock-oracle-adapter --log`,
2026-07-23, `main`):

| Fixture               | Import time | Heap delta | Avg lookup |
| ---------------------- | ----------: | ---------: | ---------: |
| current (vendored)     |     ~40 ms  |   ~0.6 MB  |   ~5.4 µs  |
| synthetic 10,000       |     ~31 ms  |   ~0.7 MB  |   ~0.49 µs |
| synthetic 50,000       |     ~22 ms  |   ~0.5 MB  |   ~0.75 µs |
| synthetic 100,000      |     ~19 ms  |  (noisy, GC-dependent) | ~0.53 µs |
| synthetic 200,000      |     ~15 ms  |   ~0.6 MB  |   ~0.44 µs |

(A second run in the same log shows the same shape: 11–41 ms import,
sub-megabyte heap deltas, sub-microsecond average lookups at every size —
run-to-run noise, not a trend.)

Import time does not grow with fixture size in this range — V8's JSON
parser and object-literal allocation are fast enough that GC/JIT warm-up
noise dominates over the actual size effect. Heap delta stays under 1 MB
even at 200k entries. Lookup latency stays sub-microsecond throughout,
since it's a single hash-map access regardless of table size.

## Decision

Per #29's own gating condition, do not implement the lazy/streaming loader.
The current vendored fixture set is nowhere near 200k entries, and even at
200k the eager-import approach shows no meaningful cost. `StubOracle`'s
behavior, tests, and bundle size are unchanged by this PR.

## When to revisit

Re-open this if the vendored `grydlock-testkit` fixture set grows
significantly past the 200k-entry range already covered above, or if a
future CI run of `tests/benchmarks/StubOracle.benchmark.test.ts` shows
import time or heap delta becoming a real problem for the extension's
startup budget. Pull the numbers from that run's `console.log` output the
same way this document did, rather than re-deriving a new harness.
