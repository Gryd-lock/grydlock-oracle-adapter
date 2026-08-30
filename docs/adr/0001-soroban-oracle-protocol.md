# 1. A finality-aware Soroban oracle protocol for `SorobanOracle`

## Status

Accepted (foundational increment). This ADR defines the protocol `SorobanOracle`
(`src/SorobanOracle.ts`) targets and validates against. It does **not** claim a live,
network-connected oracle client exists yet — see [Scope of this increment](#scope-of-this-increment).

## Context

The audit behind issue #109 found three problems with the state of this repo:

1. `README.md` described a live oracle connection and referenced `src/SorobanOracle.ts`, which
   did not exist.
2. `StubOracle` (`src/StubOracle.ts`) returns `DEFAULT_SCORE = 0` for any syntactically valid
   destination it doesn't have a fixture score for. That is the correct behavior for a
   development stub whose whole point is "always have a number to render," but it is exactly the
   failure mode a production risk oracle must never exhibit: **an oracle that can't answer should
   never look identical to an oracle that answered "low risk."** Silently downgrading "I don't
   know" to "0" is indistinguishable, from the extension's point of view, from a real all-clear.
3. `@stellar/stellar-sdk` sits in `dependencies` but nothing in `src/` reads a contract with it,
   and no code anywhere in the adapter captures which network it talked to, which contract
   version answered, which ledger the answer reflects, or whether that ledger is settled enough
   to trust.

This ADR fixes (3) by specifying, precisely, what a `SorobanOracle` implementation reads,
how it decides a response is trustworthy, and how every failure mode — including "I don't have an
opinion" and "I haven't decided yet" — surfaces as something other than a bare number.

## Scope of this increment

This ADR, together with the `SorobanOracle` scaffolding it accompanies, delivers:

- The protocol this adapter targets: method name, destination encoding, response schema,
  absence/error semantics, version range, and finality policy (this document).
- A versioned, runtime-validated schema for that protocol (`src/fixtures/soroban/`).
- New typed errors for every failure mode this protocol introduces (`src/OracleError.ts`).
- `SorobanOracle`, implemented against an **injectable transport interface**
  (`SorobanRpcTransport`), plus a deterministic in-memory fake transport for tests
  (`tests/support/FakeSorobanRpcTransport.ts`).

It deliberately does **not** deliver:

- A real network transport (an `@stellar/stellar-sdk` `Server`/RPC client that actually calls a
  Soroban contract and decodes real XDR). `SorobanRpcTransport` is the seam a future PR fills in.
- Endpoint failover or multi-endpoint consistency logic across the allowlisted RPC endpoints in
  `SorobanOracleConfig.rpcEndpoints`. Today the config only validates that the list is non-empty
  and well-formed.
- Any live testnet call with a real result. `tests/SorobanOracle.testnet.test.ts` is gated behind
  `GRYDLOCK_TESTNET_CONTRACT_ID` and is a no-op without it — see that file.
- An authoritative external contract interface. No deployed risk-oracle Soroban contract exists
  that this repo's owners control or can point at yet. **Every wire shape in this document is this
  adapter's own target, written so a real contract can be built or adapted to match it** — it is
  not a transcription of an existing, externally-ratified interface. Section
  [Contract interface stability](#contract-interface-stability) makes this explicit.

Issue #109 (the epic) also lists #1, #2, #3, #4, #15, #22, #66, #90, and #92 as dependencies. None
of those are resolved by this increment; this document does not attempt to close #109.

## Decision

### Contract method and interface version

`SorobanOracle` targets a single contract entry point, `get_score`, versioned independently of
this package's own semver:

```
SOROBAN_GET_SCORE_METHOD = "get_score"
```

Every response the contract returns is tagged with the interface version that produced it
(`interfaceVersion: number`, a positive integer starting at 1). There is **no separate
"negotiate a version" round trip** — Soroban `invoke`/`simulate` calls are single request/response
exchanges with no session state to negotiate over, so version compatibility is checked
per-response instead: the caller states the newest version it understands as a hint
(`SorobanScoreRequest.interfaceVersion`, currently the top of its configured range), and the
contract answers however it answers; `SorobanOracle` then checks the version the response
actually reports against `SorobanOracleConfig.supportedInterfaceVersionRange` and fails closed
(`UnsupportedInterfaceVersionError`) if it falls outside that range. A future contract could add a
dedicated `get_interface_version()` preflight call if a true handshake becomes necessary; nothing
here precludes that, but it isn't implemented because there's no live contract to preflight
against yet.

### Destination encoding

Requests carry destinations as the `ValidatedDestination` union already defined in
`src/DestinationValidator.ts` — this adapter does not re-derive address parsing. Every destination
passed to `SorobanOracle.getScore`/`getScoreDetailed`/`getScoreCancellable` is run through
`validateDestination()` first; a malformed or forged identifier throws `InvalidDestinationError`
before a request is ever built, exactly as it does for `StubOracle`.

`M...` muxed accounts are scored under their canonical base `G` account (matching
`DestinationValidator`'s existing decision); `C...` contracts and `L...` liquidity pools are
passed through as-is; SEP-11 `<code>:<issuer>` assets are passed through as their decomposed
`{ assetCode, assetCodeType, issuer }` form. Encoding that into the Soroban `ScVal`/XDR the
contract actually expects on the wire is the real transport's job (out of scope here, see above);
`SorobanScoreRequest.destination` gives it a `ValidatedDestination` to encode from rather than a
raw string to re-parse.

### Response schema

`SorobanRpcTransport.invokeGetScore` returns `unknown` — the transport's job ends at "make the
network call and decode the XDR envelope into a plain JS value." `SorobanOracle` never trusts that
value structurally; it runs it through `decodeSorobanRawResponse()`
(`src/fixtures/soroban/schema.ts`), which validates every field by hand (this repo has no
schema-validation library, and this ADR doesn't introduce one) and throws
`SorobanResponseSchemaError` — caught and re-thrown by `SorobanOracle` as
`MalformedOracleResponseError` — the moment anything doesn't match:

```ts
interface SorobanRawResponse {
  interfaceVersion: number; // positive integer
  networkPassphrase: string; // non-empty
  contractId: string; // non-empty
  ledger: {
    sequence: number; // the ledger the score was computed against
    closeTimeUnixMs: number; // that ledger's close time
    latestSeenSequence: number; // the RPC node's most recently observed ledger
  };
  outcome: SorobanRawOutcome; // see "Absence semantics" below
}
```

This is deliberately flat and defensively over-specified (e.g. `latestSeenSequence` duplicates
information the transport's own RPC calls would otherwise need to track separately) so
`SorobanOracle` can make every trust decision from one already-decoded object, without reaching
back into the transport or making a second call.

### Absence semantics

Three situations look similar from the outside ("I asked, and got nothing usable back") but mean
very different things, and this protocol keeps them distinguishable all the way out to the typed
error the caller catches:

| Situation | Meaning | Result |
| --- | --- | --- |
| **No score exists** | The oracle has evaluated this destination and, as a considered, authoritative answer, has no risk opinion to report (e.g. explicitly out of scope). This is a permanent, semantic answer from the contract itself. | `outcome.variant === 'unscored'` → `UnrecognizedDestinationError` (reusing the existing "valid destination, not recognized" error — its meaning already matches exactly) |
| **Not yet computed** | The oracle knows about the destination and is tracking it, but scoring hasn't finished (e.g. queued, awaiting more on-chain history). This may resolve to an actual score later. | `outcome.variant === 'pending'` → `ScoreNotYetComputedError` (new) |
| **Provider failure** | The adapter could not get *any* answer — the transport itself failed (RPC unreachable, timed out, or was cancelled) before a contract response existed to interpret at all. | `OracleUnavailableError` / `OracleTimeoutError` / `OracleCancelledError` (existing), thrown directly from the transport call, never reaching schema decoding |

Critically: **none of these three ever produce a numeric score.** Each is a distinct thrown error.
This is the direct fix for the `StubOracle` anti-pattern described in Context: a caller cannot
mistake "I don't know" for "0," because there is no code path that turns either kind of absence
into a number.

### Score range

A `scored` outcome's `score` is required to be an integer in the closed interval `[0, 100]`,
matching `RiskOracle`'s existing contract. `decodeSorobanRawResponse()` rejects a non-integer or
out-of-range score as a malformed response (`MalformedOracleResponseError`) rather than clamping
it — a contract bug that produces `101` or `7.5` is a signal worth surfacing loudly, not silently
correcting.

### Finality policy

Every `scored` response also carries the ledger checkpoint it was computed against. Soroban
transactions have fast probabilistic finality (Stellar's consensus protocol does not reorg a
closed ledger the way probabilistic-finality chains do), but a value read from a single RPC
endpoint can still reflect a ledger that endpoint itself hasn't fully caught up on, or that is old
enough to no longer reflect current on-chain risk. `SorobanOracleConfig.finalityPolicy` names two
independent thresholds:

```ts
interface SorobanFinalityPolicy {
  minConfirmations: number; // ledgers that must have closed after the result's ledger
  maxResultAgeMs: number; // max age of the result's ledger close time
}
```

`SorobanOracle` computes `observedConfirmations = max(0, ledger.latestSeenSequence -
ledger.sequence)` and classifies every `scored` response into exactly one of three labels:

- **Insufficiently final** — `observedConfirmations < minConfirmations`. The result hasn't
  accumulated enough confirmations for this adapter to trust it as settled. This **fails closed**:
  `SorobanOracle` throws `InsufficientFinalityError` rather than returning the value at all,
  because a not-yet-final answer, silently returned, is indistinguishable from a fully trustworthy
  one — the same anti-pattern as `StubOracle`'s default, just at the ledger layer instead of the
  destination layer.
- **Live/verified** — enough confirmations have elapsed *and* `now - ledger.closeTimeUnixMs <=
  maxResultAgeMs`. Reported as `cacheStatus: 'live'`.
- **Stale** — enough confirmations have elapsed, but the ledger is older than
  `maxResultAgeMs`. Unlike "insufficiently final," this is still returned — the data is settled,
  just possibly outdated — but downgraded to `cacheStatus: 'cache-stale'` rather than `'live'`, so
  a caller (or `ProvenanceOracle`'s audit trail) can see the distinction rather than treating a
  stale read as equivalent to a fresh one.

`SorobanScoredResult` (returned from `getScoreDetailed`/`getScoreCancellable`, a strict superset of
`ScoredResult`) carries the raw numbers behind that classification —
`ledgerSequence`, `ledgerCloseTimeUnixMs`, `observedConfirmations` — plus `networkPassphrase`,
`contractId`, and `interfaceVersion`, so "why did the user see this score" (the question
`ProvenanceOracle`'s doc comment already asks) can be answered down to the exact ledger and
contract build that produced it.

### Wrong-network / wrong-contract rejection

`SorobanOracleConfig.networkPassphrase` and `SorobanOracleConfig.contractId` are validated eagerly
at construction time (see below). Every response is checked against both **before** any of the
absence/finality logic runs: a response whose `networkPassphrase` doesn't match throws
`WrongNetworkError`; a response whose `contractId` doesn't match throws `WrongContractError`. This
ordering matters — a wrong-network or wrong-contract response must never reach caching or
finality-based trust decisions, because "trustworthy answer from the wrong contract" is not a
weaker version of "trustworthy answer," it's a different question entirely.

### Fixture/stub transports are refused in production

`SorobanOracleConfig.environment` is a required, explicit field (`'production' | 'staging' |
'development' | 'test'` — no default). Every `SorobanRpcTransport` declares a `transportKind:
'live' | 'fixture'`. `SorobanOracle`'s constructor throws synchronously if `environment ===
'production'` and `transportKind === 'fixture'`. This is the direct, mechanical enforcement of
"production code paths must reject fixture/stub sources" — it is not a lint rule or a code-review
convention, it is a constructor check that cannot be bypassed by forgetting to swap an import.

### Contract interface stability

Nothing in this document is sourced from a deployed, externally-controlled contract — see
[Scope of this increment](#scope-of-this-increment). `src/fixtures/soroban/protocol.ts` carries a
`schemaVersion` field precisely so that once a real contract interface exists (tracked by the
epic's listed dependencies), this protocol can be revised — and the version bumped — without
being confused for silent drift. Until then, treat every shape in this ADR as this adapter's
target, not as ground truth about a contract that exists today.

## Consequences

- Every failure mode a `SorobanOracle` caller can hit is a distinct, typed, catchable error (or,
  for genuinely live/stale data, an explicit `cacheStatus` on `SorobanScoredResult`) — never a bare
  number standing in for "I don't know."
- A future real `SorobanRpcTransport` implementation only needs to produce values matching
  `SorobanRawResponse`; it does not need to know about finality policy, version checks, or error
  mapping — all of that lives in `SorobanOracle` itself and is exercised today against the fake
  transport in `tests/SorobanOracle.test.ts`.
- Because the protocol is provisional (see [Contract interface stability](#contract-interface-stability)),
  landing a real contract may require revising `src/fixtures/soroban/protocol.ts`'s
  `schemaVersion` and the shapes in `schema.ts`. That revision is expected, tracked work, not a
  sign this ADR was wrong.
- `SorobanOracle` is not wired into any default export composition (`compose`, `FallbackOracle`
  tiers, etc.) in this increment, and `README.md` is updated to describe it as scaffolding, not as
  a drop-in replacement for `StubOracle`.
