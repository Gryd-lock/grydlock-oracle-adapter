# ADR: restart-safe lifecycle, persistence, and cross-context coordination (#112)

## Context

`withCache`, `CoalescingOracle`, and `CircuitBreakerOracle` keep process-local
state with no durable schema, no namespace, and no disposal contract.
`withRateLimit`'s `BroadcastChannel` gossip degrades to `N * budget` under
partition and exposes no way to close its channel or listener. None of this
is restart-safe: a Manifest V3 service worker can be suspended and cold-
started at any time, and nothing currently answers "what happens to cached
evidence, in-flight leases, or the rate limiter's own counters when that
happens."

This ADR covers what actually landed against the issue's five required-scope
items (A–E) and is explicit about what didn't, since two of the issue's own
dependencies (Epic 1: network/contract identity; Epic 2: namespace/request
semantics) haven't landed yet.

## Decisions

### A. Lifecycle owner — `OracleLifecycleManager`

One class owns init/ready/health/disposal for a set of registered
`Disposable` resources (`src/lifecycle/OracleLifecycleManager.ts`), backed by
`DisposableGroup` (`src/lifecycle/Disposable.ts`) for idempotent, reverse-
order teardown that still disposes every member even if one throws.
`createProductionOracleStack` (`src/createProductionOracleStack.ts`) is the
validated factory: it composes `withCache` (outermost) → `withRateLimit` →
`CircuitBreakerOracle` → `CoalescingOracle` (innermost, around the raw
oracle), registers every resource it itself constructs onto one
`OracleLifecycleManager`, and rejects an evidence-contract violation
(`cache.maxEvidenceAgeMs < cache.ttlMs`, or `store` with no `namespace`)
before constructing anything.

**Alternative considered:** let each middleware manage its own teardown
independently, with the caller responsible for calling `dispose()` on each.
Rejected — that's exactly the "no central factory owns composition or
cleanup" problem the issue names as the root cause; a caller composing N
middlewares by hand has N chances to get disposal order or double-disposal
wrong.

### B. Durable namespaced cache

`CacheNamespace` (`network`, `contract`, `evidenceSchemaVersion`,
`policyVersion`) is folded into every persisted key
(`src/middleware/withCache.ts`). Persistence goes through a minimal
`DurableStore` contract (`src/lifecycle/DurableStore.ts`: `getAll`/
`setMany`/`deleteMany`/`clear`) with an in-memory implementation for tests
and a `chrome.storage.local`-shaped adapter for production. Every read
through `readEnvelope` checks both a persistence schema version and a
namespace match; anything that fails either check is quarantined (deleted,
never loaded) rather than guessed at — "corrupt persistence fails closed and
is recoverable."

`maxEvidenceAgeMs` adds an absolute cutoff, independent of `ttlMs`/`staleMs`,
past which an entry is never served — not fresh, not stale-while-revalidate.
This is checked _before_ the stale-while-revalidate branch in
`getScoreDetailedImpl`, so it genuinely overrides it rather than just adding
another expiry tier.

**Alternative considered:** namespace the in-memory `Map` key itself (not
just the persisted key). Rejected as redundant — one `withCache(...)` call
already corresponds to exactly one namespace by construction (a network
switch means constructing a _new_ `withCache` with a new namespace, not
reusing one instance across namespaces), so the in-memory map never needs to
disambiguate. Namespacing only matters at the persistence boundary, which is
exactly where restart can hand it stale data from a different trust
boundary.

### C. Cross-context coordination — `RefreshLeaseCoordinator`

`src/lifecycle/RefreshLeaseCoordinator.ts` gates `withCache`'s background
stale-while-revalidate fetch behind a lease. Two strategies, chosen
automatically:

- **Web Locks** (`navigator.locks`), when available: exact mutual exclusion
  with no protocol to get wrong, and the lock is released by the platform
  itself the instant its holding context dies — a strictly better answer to
  "what happens when the owner is killed" than any timeout this package
  could invent.
- **Gossip fallback** (`BroadcastChannel`), otherwise: a bounded ticket
  scheme modeled on Lamport's bakery algorithm — broadcast a
  `(timestamp, contextId)` ticket, wait one bounded arbitration window, the
  lowest ticket wins. An owner that never releases is recovered from after
  `leaseMs` (bounded recovery), not never.

**Alternative considered:** a single BroadcastChannel-elected "leader"
holding the whole budget (the same option `withRateLimit`'s own module doc
already rejected for the same reason, see `src/middleware/withRateLimit.ts`).
Rejected here too: a Manifest V3 worker can vanish mid-term with no
synchronous way for peers to detect it, so leader election needs its own
failure-detection/re-election machinery that a bounded lease with automatic
Web-Locks-backed release, or gossip-based timeout recovery, doesn't.

### D. Rate-limit authority hardening

`src/middleware/withRateLimit.ts`: gossip messages now carry a protocol
version (mismatched versions are dropped, not best-effort-parsed);
`contextId` length, per-message bucket count, and per-bucket clock skew are
all bounded and validated; tracked-context count is capped
(`maxTrackedContexts`, least-recently-seen evicted first) so a flood of
forged identities can't grow memory without bound even before natural
staleness pruning would catch up. `getCoordinationStatus()` reports
`'coordinated'` vs `'local-only'` explicitly — never claims a global budget
it can't back up. `dispose()` removes the listener always, and closes the
channel only if this call constructed it (never a caller-supplied one).
Optional `store` persists this context's own bucket counts so a warm restart
with a _stable_ `contextId` doesn't get a silently-fresh budget mid-window.

**Alternative considered:** a fully authoritative server-side quota endpoint,
noted in the issue as an option ("selected as the authority"). Out of scope
here per the issue's own "Out of scope" section (server quota infrastructure
unless selected as the authority) — no such endpoint exists yet in this
repo.

### E. Restart transitions

Covered by composition, not a separate state machine:

- **Cold start**: `withCache` lazily hydrates from `store` on first use
  (namespace/schema/max-age-checked); `withRateLimit` lazily hydrates its own
  bucket if `store` + a stable `contextId` are configured.
- **Warm restart, same process**: unaffected — nothing here changes
  in-memory-only behavior when no `store` is configured.
- **Suspend/resume (MV3 worker)**: a Web-Locks-held lease is released by the
  platform on suspend; a gossip-held one is recovered after `leaseMs`. Cache
  and rate-limit state persist across the resume if `store` is configured.
- **Network/contract/policy change**: bump `namespace`, construct a new
  stack. Old records are unservable immediately (namespace mismatch on
  read), not eventually.
- **Circuit recovery**: unchanged from `CircuitBreakerOracle`'s existing
  HALF_OPEN protocol (see `CONCURRENCY_INVARIANTS.md`) — restart resets a
  breaker to `CLOSED` (in-memory only), which is the conservative direction
  (never resumes into a falsely-OPEN state that never recovers, and never
  resumes into a falsely-trusted HALF_OPEN probe race either, since that
  state isn't persisted).

## Explicitly out of scope / deferred

- **Ledger-lag evidence age** (as opposed to wall-clock evidence age):
  `maxEvidenceAgeMs` caps wall-clock age. A ledger-lag signal would need the
  wrapped oracle to report it as evidence, which depends on Epic 1
  (network/contract identity) and isn't available on `ScoredResult` today.
- **A fully authoritative server-side rate-limit quota.**
- **General distributed cache infrastructure, aggregator reputation, UI
  behavior** — all explicitly out of scope per the issue.

## Required verification

- `tests/lifecycle/*.test.ts` — `Disposable`/`DisposableGroup`,
  `DurableStore` (including corruption/quota-failure handling),
  `RefreshLeaseCoordinator` (Web Locks path, gossip fallback, the "50 cold
  requests / 5 contexts / 1 active lease" scenario, bounded recovery after a
  killed owner, hardened message validation), `OracleLifecycleManager`.
- `tests/withCache.lifecycle.test.ts` — namespace validation, hydration
  (including cross-namespace non-hydration and corruption quarantine),
  `maxEvidenceAgeMs` overriding stale-while-revalidate, lease-gated
  revalidation, disposal.
- `tests/withRateLimit.lifecycle.test.ts` — coordination status, disposal
  (including channel-ownership rules), hardened gossip validation, tracked-
  context memory bounds, restart persistence with a stable `contextId`.
- `tests/createProductionOracleStack.test.ts` — end-to-end composition,
  validation, and lifecycle teardown.

All existing suites (fuzzers, concurrency harnesses, adversarial-gossip,
CRDT-property tests) pass unmodified — this work is additive to
`withCache`/`withRateLimit`'s existing behavior, not a rewrite of it.
