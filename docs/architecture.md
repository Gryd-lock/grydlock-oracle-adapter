# Architecture

How a destination string becomes a score, and the design choices behind each step. For the
wire protocol see [ADR 0001](adr/0001-soroban-oracle-protocol.md). For the contract see
[`contract/README.md`](../contract/README.md).

## The interface

```ts
interface RiskOracle {
  getScore(destination: string): Promise<number>; // 0–100
}

interface DetailedRiskOracle extends RiskOracle {
  getScoreDetailed(destination: string): Promise<ScoredResult>;
}

interface ScoredResult {
  score: number; // 0–100
  timestamp: number; // epoch ms
  source: string; // which oracle answered, e.g. "SorobanOracle"
  cacheStatus: 'live' | 'cache-fresh' | 'cache-stale' | 'default' | 'unknown';
  confidence?: number;
}
```

Defined in [`src/RiskOracle.ts`](../src/RiskOracle.ts). grydlock-extension depends on this shape
only. `SorobanOracle.getScoreDetailed` returns a superset, `SorobanScoredResult`, which adds
the network passphrase, contract id, interface version, ledger sequence, ledger close time and
observed confirmations.

## Request path (`SorobanOracle`)

1. **Validate the destination** ([`src/DestinationValidator.ts`](../src/DestinationValidator.ts)).
   A bad input throws `InvalidDestinationError` before any network call.
2. **Encode it** as the contract's `Target` enum ([`src/StellarRpcTransport.ts`](../src/StellarRpcTransport.ts)).
3. **Simulate** `get_score` through `rpc.Server.simulateTransaction` with a null source
   account. Nothing is signed, submitted or paid for.
4. **Decode** the `(Score, LedgerStamp, u32)` return value and re-validate it against the
   protocol schema ([`src/fixtures/soroban/schema.ts`](../src/fixtures/soroban/schema.ts)).
5. **Check trust**: interface version, then network, then contract, then the finality policy
   (minimum confirmations; results older than `maxResultAgeMs` are marked `cache-stale`).
6. **Return a score, or throw a typed error.** `Unscored` and `Pending` become errors, never a
   number. See [errors.md](errors.md).

## Destination validation

| Shape                    | Example          | Decision                                 |
| ------------------------ | ---------------- | ---------------------------------------- |
| `G…` ed25519 account     | `GCRRYBV5…`      | Accepted                                 |
| `M…` muxed account       | `MCRRYBV5…`      | Accepted, scored as its base `G` account |
| `C…` contract            | `CADQOBYH…`      | Accepted                                 |
| `L…` liquidity pool      | `LAEQSCIJ…`      | Accepted                                 |
| `<code>:<issuer>` asset  | `SCAM:GAJLLIIP…` | Accepted (SEP-11 code + `G` issuer)      |
| `S…` `T…` `X…` `P…` `B…` | —                | Rejected (signer/transaction constructs) |
| anything else            | `not-an-address` | Rejected                                 |

A muxed address is the same account with a routing tag, so its risk is the base account's
risk. Rejecting it would leave exchange deposit addresses unchecked.

[`src/StrKeyCodec.ts`](../src/StrKeyCodec.ts) implements base32, CRC16-XModem and the
version-byte checks itself rather than using the SDK. That keeps `StubOracle`-only bundles free
of `@stellar/stellar-sdk`. [`tests/StrKeyCodec.differential.test.ts`](../tests/StrKeyCodec.differential.test.ts)
fuzzes it against the SDK's `StrKey` with a corpus of at least 5,000 inputs.

## Fixture data (`StubOracle`)

`src/fixtures/testkit/` holds a vendored copy of grydlock-testkit's `scores.json` and
`destinations.json`. `npm run sync:fixtures` refreshes it, and a weekly workflow does the same.
The JSON is embedded as text modules and parsed by a small incremental tokenizer
([`jsonScanner.ts`](../src/fixtures/testkit/jsonScanner.ts)). Each entry is validated as it
is read, so a bad entry fails at module load with its line and column.
[`tests/benchmarks/fixtureStreaming.budget.test.ts`](../tests/benchmarks/fixtureStreaming.budget.test.ts)
enforces latency and memory budgets at 50,000 entries.

`StubOracle` returns `0` for destinations missing from the fixtures. That is fine for UI
development and wrong for production, which is why `SorobanOracle` never does it.

## Resilience and composition

Middleware are plain `(next: RiskOracle) => RiskOracle` wrappers. `compose` applies them
outermost-first:

```ts
const oracle = compose(
  withCache({ ttlMs: 60_000 }), // outermost: a hit skips everything below
  withTimeout({ timeoutMs: 3_000 }), // innermost: bounds each real call
)(live);
```

`CircuitBreakerOracle` stops calling a failing source for a cooldown window.
grydlock-extension uses cache → breaker → timeout.

## Stable and experimental API

[`src/index.ts`](../src/index.ts) is split into two sections:

- **Stable** (semver-governed): the live Soroban client, `StubOracle`, `compose` /
  `withCache` / `withTimeout` / `CircuitBreakerOracle`, the error taxonomy, and destination
  validation.
- **Experimental** (`@experimental`, may change in a minor release): `FallbackOracle`,
  `RiskOracleAggregator`, `BatchRiskOracle`, `CoalescingOracle`, `ProvenanceOracle` /
  `withProvenance`, and the `RiskDecision` contract. Nothing consumes these yet. Issue #130
  tracks promoting or removing each one.

### Provenance logging (experimental)

`ProvenanceOracle` wraps any oracle and logs one `score_provenance` record per call through an
injected `Logger`. The record holds source, cache status, timestamp, latency and outcome. Use it
to answer "why did this user see this score?"

## Bundle size

The adapter ships inside a browser extension, so `npm run size` enforces budgets on every PR.
`@stellar/stellar-sdk` is external, just as it is in the build.

| Import                       | Minified | Gzip    | Budget |
| ---------------------------- | -------- | ------- | ------ |
| `StubOracle` only            | 9.6 KB   | 3.9 KB  | 10 KB  |
| `createSorobanOracle` (live) | 20.4 KB  | 6.5 KB  | 30 KB  |
| Full barrel                  | 55.7 KB  | 17.7 KB | 58 KB  |

The `StubOracle`-only check also has a module allowlist, so it fails if Soroban code leaks into
that bundle.
