# Migrating from the numeric score API to the evidence-bearing decision contract

This document explains `src/legacy/numericAdapter.ts` and how to move a
consumer of the legacy `RiskOracle.getScore(): Promise<number>` contract
onto the new `RiskDecision` union (`src/RiskDecision.ts`), introduced
alongside it, additively (progresses #110).

## Why the numeric contract needed a companion, not a replacement

`RiskOracle.getScore` has exactly one success shape: a number 0-100. Every
outcome that isn't "here is a trustworthy score" has to be squeezed into
that same number, or into an exception nobody is required to catch
differently. In practice this repo already does that squeezing:

- `StubOracle`/`DefaultOracle` return `0` for a destination they've never
  heard of — indistinguishable, to a caller, from a destination that was
  actually evaluated and found to be zero-risk.
- Cache/fallback/aggregator timestamp semantics differ subtly across
  `ProvenanceOracle`, `FallbackOracle`, and `withCache`, because none of
  them share a single explicit notion of "how stale is this."
- There is nowhere to put "an extension warning policy vetoed this
  destination" that isn't itself a risk judgment — it gets mixed into the
  same number space as genuine evidence.

`RiskDecision` fixes this by making every one of those outcomes its own
variant (`verified`, `unscored`, `degraded`, `policy-blocked`,
`unavailable`, `incompatible`) instead of one number. This is **additive**:
`RiskOracle`, `ScoredResult`, and every existing decorator
(`RiskOracleAggregator`, `BatchRiskOracle`, `FallbackOracle`, `withCache`,
`CoalescingOracle`, `CircuitBreakerOracle`, ...) are unchanged by this PR
and keep working exactly as before. Migrating those decorators onto
`RiskDecision` is deferred follow-up work, not part of this change.

## Why the adapter fails closed

`src/legacy/numericAdapter.ts` exports `toLegacyScore` (and
`toLegacyRiskOracle`, which wraps an async `RiskDecision` producer as a
`RiskOracle`). Both are marked `@deprecated` — they exist to bridge, not to
be a long-term integration point.

The adapter converts a `RiskDecision` to a number for exactly two outcomes:

| Outcome          | Resolves to a number?                                   |
| ---------------- | ------------------------------------------------------- |
| `verified`       | Yes, always                                             |
| `degraded`       | Only if `options.acceptDegraded === true` (default: no) |
| `unscored`       | **No** — throws `UnrecognizedDestinationError`          |
| `unavailable`    | **No** — throws `OracleUnavailableError`                |
| `incompatible`   | **No** — throws `ContractIncompatibilityError`          |
| `policy-blocked` | **No** — throws `ContractIncompatibilityError`          |

This is deliberately the opposite of what `StubOracle`/`DefaultOracle` do
today. Those existing implementations are consumer-facing endpoints that
have to produce _some_ number because that's the entire contract they
implement — defaulting to `0` there is a reasonable, honestly-documented
choice given what `RiskOracle` allows them to express. `toLegacyScore` is
different: it sits between a _richer_ source (one that already knows the
difference between "unscored" and "unavailable") and a _narrower_ consumer.
Silently choosing a number in that position — e.g. mapping `unscored` to
`0` — would throw away information the source already had and hand the
legacy consumer a number indistinguishable from a real "verified,
zero-risk" result. Once that number is in a legacy caller's hands, nothing
downstream can tell the difference. Throwing preserves the distinction by
forcing the caller to notice.

`degraded` is the one gray area: a `degraded` decision _does_ have a
number, it's just evidence the source itself flagged as insufficiently
fresh. Whether "stale but present" is acceptable for a given legacy call
site is a policy decision this adapter can't make for you, so it's opt-in
per call (`acceptDegraded: true`) rather than a library-wide default in
either direction.

## Migrating a consumer

**If you own the call site and can consume `RiskDecision` directly**, do
that instead of using the adapter at all:

```ts
const decision = await source.getDecision(destination);

switch (decision.outcome) {
  case 'verified':
    // use decision.score, decision.confidence, ...
    break;
  case 'degraded':
    // decide per-call-site whether stale evidence is acceptable
    break;
  case 'unscored':
    // "no opinion" — not the same as an error
    break;
  case 'policy-blocked':
    // a warning-policy veto, not raw evidence
    break;
  case 'unavailable':
  case 'incompatible':
    // handle as a failure
    break;
}
```

Because `RiskDecision` is an exhaustive discriminated union (see
`tests/type-tests/RiskDecision.type-test.ts`), a `switch` like this without
a `default` is a compile error the moment a new outcome variant is added
that you haven't handled — the type system keeps you honest as the
contract evolves.

**If you have an existing numeric call site you can't change yet**, wrap
your `RiskDecision`-producing source with `toLegacyRiskOracle`:

```ts
import { toLegacyRiskOracle } from 'grydlock-oracle-adapter';

const legacyOracle: RiskOracle = toLegacyRiskOracle(
  (destination) => mySource.getDecision(destination),
  { acceptDegraded: false }, // explicit, matching the fail-closed default
);

const score = await legacyOracle.getScore(destination);
```

Existing `try`/`catch` handling around `OracleUnavailableError` and
friends keeps working unchanged — the adapter reuses this package's
existing error taxonomy (`src/OracleError.ts`) rather than inventing new
error types for the numeric-facing side of the bridge.

**Either way**, treat the adapter as a stepping stone: the point of
`RiskDecision` is that the six outcomes above stop being collapsible into
one number. A long-lived integration that keeps using
`toLegacyScore`/`toLegacyRiskOracle` has, by construction, given that up
for whatever it wraps.
