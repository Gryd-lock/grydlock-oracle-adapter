# Privacy and threat model: `RiskDecisionProvenance`

This document covers `src/RiskDecisionProvenance.ts` — the privacy-safe
provenance v2 event schema introduced alongside the `RiskDecision` contract
(progresses #110). It is additive: `src/ProvenanceOracle.ts`'s existing
`ScoreProvenance` event and `ProvenanceOracle` class are unchanged.

## Why this exists

The audit behind #110 found that `ProvenanceOracle` logs the full
destination, the resolved score, and a stringified error for every call,
with no redaction and no documented retention expectation. That's a
reasonable default for a private, single-operator log sink, and this
document does not ask anyone to change `ProvenanceOracle`'s existing
behavior. But as more consumers wire up logging against a shared or
multi-tenant sink, "log everything, redact nothing, by default" is the
wrong default for a _new_ event schema to inherit. `RiskDecisionProvenance`
starts from the opposite default: nothing beyond stable, already-public
taxonomy strings is included unless a caller explicitly opts in.

## What's in the default event

Call `createRiskDecisionProvenanceEvent(decision, meta)` with no
`redaction` argument (or `{}`) and you get:

- `event`, `schemaVersion`, `correlationId`, `outcome`, `source`,
  `observedAt`, `timestamp`, `latencyMs` — plumbing and taxonomy, not
  destination-identifying.
- `score`, when `decision.outcome` is `verified`/`degraded` — a number
  0-100 carries no destination or identity information on its own.
- `reason` / `policyRuleId`, when the outcome carries one — these are
  **stable machine values this package itself defines**
  (`RiskDecision.ts`'s `UnscoredRiskDecision['reason']`,
  `DegradedRiskDecision['degradationReason']`, etc.), not free text from a
  provider.

## What's excluded by default, and how to opt in

| Data                                | Included by default?                                                                          | Opt-in                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Raw destination                     | No                                                                                            | `redaction.includeRawDestination: true`                                 |
| Pseudonymized destination reference | No                                                                                            | `redaction.includePseudonymizedDestination: true` (+ `destinationSalt`) |
| RPC URLs, issuer keys               | No — excluded as a consequence of excluding the raw destination, which is where they'd appear | Only reachable via `includeRawDestination`                              |
| Raw provider error text             | No                                                                                            | `redaction.includeRawError: true` (+ `meta.rawError`)                   |

Each is a separate, explicit boolean — turning one on does not turn on the
others. There is no single "verbose mode."

### `correlationId` is not derived from the destination

`meta.correlationId` (typically a `RequestContext.correlationId` — see
`src/RequestContext.ts`) is supplied by the caller and is **not** a
function of the destination. This is deliberate: a join key derived from
the destination (even a hashed one, salted or not) lets anyone holding a
stream of these events reconstruct a full timeline for one destination
just from the join key repeating, with no need to ever see the destination
field. A per-request, destination-independent correlation id avoids that:
events for two different requests about the same destination do not share
a correlation id.

### The pseudonymized destination reference is not a security boundary

`pseudonymizeDestination(destination, salt)` is a salted, **non-cryptographic**
hash (FNV-1a, 32 bits, hex-encoded). It exists so a log consumer can notice
"these N events are about the same destination" without ever seeing the
destination — a real utility for debugging and rate-limiting-style
analysis on the sink side. It is **not** resistant to a targeted
de-anonymization attempt: real Stellar addresses are a public, largely
enumerable space (on-chain, indexable), so anyone holding both the salt and
a candidate list of destinations can brute-force the mapping in a hash
space this small. Do not treat `destinationRef` as safe to share with a
party you would not also trust with the destination itself, and do not
reuse the same `destinationSalt` across trust boundaries you want to keep
separable — a shared salt lets two otherwise-separate sinks correlate the
same destination against each other even if neither ever sees it directly.

## What a sink must do

- Treat `destination` (when present — i.e. `includeRawDestination` was
  used) and `rawErrorDetail` (when present) as sensitive: they can contain
  a full Stellar address/asset identifier or provider-internal detail
  (which has in practice included RPC endpoint URLs). Store, transmit, and
  retain them under whatever policy you already apply to raw user
  destinations elsewhere in your system — this package has no opinion on
  what that policy should be, only that it should exist and be applied
  consistently rather than accidentally bypassed via a logging path.
- Treat `destinationRef` as pseudonymous, not anonymous, per the section
  above. Don't publish it alongside the salt used to produce it.
- Cap retention to what your own use case (debugging, abuse detection,
  analytics) actually needs, and prefer the shortest retention window that
  serves it. This package does not set a retention period for you.

## What a sink must not do

- Must not assume the default event (no `redaction` options set) is safe
  to widen later without re-reviewing what became reachable — e.g. turning
  on `includeRawError` because a debugging session needed it, and then
  forgetting to turn it back off in a shared/production sink.
- Must not log `rawErrorDetail` verbatim into a system with a different
  (more permissive) retention or access policy than the rest of your
  destination-handling data — it is capped at 200 characters and derived
  from `String(error)`/`error.message`, but that string can still contain
  operational detail (an RPC URL, an issuer key fragment) a provider's
  error text happened to include.
- Must not use `destinationRef` as if it were a stable, permanent user/account
  identifier across unrelated systems — it is scoped to one `destinationSalt`,
  and rotating the salt (recommended periodically, exactly because of the
  brute-forceability above) invalidates any such cross-system linkage.
