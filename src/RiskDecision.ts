import { OracleSource } from './RiskOracle';

/**
 * Evidence-bearing, fail-safe risk-decision contract (progresses #110).
 *
 * `RiskOracle`/`ScoredResult` (see `RiskOracle.ts`) center a single
 * `Promise<number>`: every outcome — a genuine score, "nothing is known
 * about this destination," a transport failure, a stale cache entry, a
 * warning-policy veto — has historically had to collapse onto a number (or
 * an exception someone remembered to catch). `RiskDecision` replaces that
 * collapse with an explicit, exhaustively-typed union: each outcome is its
 * own variant, carrying only the fields that make sense for it, so
 * "unscored" can never be confused with "unavailable," and a caller that
 * wants a plain number has to say so explicitly (see `legacy/numericAdapter.ts`).
 *
 * This module is purely additive: nothing here changes `RiskOracle`,
 * `ScoredResult`, or any existing decorator. Producing/consuming
 * `RiskDecision` values is opt-in for new call sites.
 */

/** This module's schema/protocol version. Bump on any breaking change to `RiskDecision`'s shape. */
export const RISK_DECISION_SCHEMA_VERSION = 1;

/** The type of {@link RISK_DECISION_SCHEMA_VERSION} — every `RiskDecision` this package produces carries exactly this value. */
export type RiskDecisionSchemaVersion = typeof RISK_DECISION_SCHEMA_VERSION;

/** The discriminant every `RiskDecision` variant carries under `outcome`. */
export type RiskDecisionOutcome =
  'verified' | 'unscored' | 'degraded' | 'policy-blocked' | 'unavailable' | 'incompatible';

/** Fields common to every `RiskDecision` variant. */
interface RiskDecisionBase<Outcome extends RiskDecisionOutcome> {
  /** Discriminant. Switch on this, not `instanceof` or duck-typing. */
  outcome: Outcome;
  /** Schema/protocol version this decision was produced against. */
  schemaVersion: RiskDecisionSchemaVersion;
  /** The Stellar address or asset identifier this decision concerns. */
  destination: string;
  /** Which oracle/tier produced this decision. A stable machine value (e.g. `"soroban-v2"`), never a class name — see `RiskDecisionValidationError` and `validateRiskDecision.ts`. */
  source: OracleSource;
  /** Epoch milliseconds at which the evidence behind this decision was observed/produced. */
  observedAt: number;
}

/**
 * Evidence was validated and is fresh enough to be used as-is: a score
 * exists, it passed runtime validation, and nothing flags it as stale or
 * policy-vetoed.
 */
export interface VerifiedRiskDecision extends RiskDecisionBase<'verified'> {
  /** Risk score, integer 0-100 inclusive (higher = higher suspected risk). */
  score: number;
  /**
   * Confidence in `[0, 1]` reported by the source, when it reports one.
   * Absence is NOT full trust — it means the source didn't report a
   * confidence signal at all, and callers must not assume `1`. Contrast
   * with `middleware/withCache.ts`'s `defaultConfidence` (a legacy,
   * `ScoredResult`-only convenience that *does* default absence to `1`);
   * nothing in this module carries that assumption forward.
   */
  confidence?: number;
  /** On-chain ledger/contract identity backing this score, when the source is itself an on-chain contract. */
  contractId?: string;
  /** Epoch milliseconds after which this decision should be treated as stale and revalidated rather than reused as `verified`. */
  expiresAt?: number;
}

/**
 * The destination is valid and the source is reachable, but no score exists
 * for it — e.g. never tracked, or explicitly excluded. This is distinct
 * from `unavailable`: the source answered; it just has no opinion.
 * Collapsing this into a numeric default (as `StubOracle`/`DefaultOracle`
 * do today, matching `RiskOracle`'s numbers-only contract) hides the
 * difference between "known safe" and "not evaluated" from the caller.
 */
export interface UnscoredRiskDecision extends RiskDecisionBase<'unscored'> {
  /** Stable machine-readable reason code, when the source reports one. */
  reason?: 'not-tracked' | 'insufficient-history' | 'excluded' | (string & {});
}

/**
 * A score exists but the evidence backing it is stale or otherwise
 * insufficiently fresh — still returned (a degraded answer can be better
 * than none), but explicitly flagged so a caller never silently treats it
 * as `verified`.
 */
export interface DegradedRiskDecision extends RiskDecisionBase<'degraded'> {
  /** Risk score, integer 0-100 inclusive, as reported despite the degradation. */
  score: number;
  /** Confidence in `[0, 1]`, when reported. See {@link VerifiedRiskDecision.confidence} — absence is not full trust here either. */
  confidence?: number;
  /** Stable machine-readable reason the evidence is degraded. */
  degradationReason: 'stale' | 'low-confidence-source' | 'partial-quorum' | (string & {});
  /** Epoch milliseconds the underlying evidence was actually produced (typically before `observedAt`, e.g. a stale cache entry served now). */
  evidenceAt: number;
}

/**
 * An extension/consumer warning policy vetoed this destination — a
 * decision *about the evidence*, kept in a separate variant from `verified`/
 * `degraded`/`unscored` per the evidence-vs-policy separation this contract
 * exists to enforce. `underlying` carries the raw evidence decision the
 * policy acted on, when there was one, so a caller can still inspect what
 * the evidence itself said.
 */
export interface PolicyBlockedRiskDecision extends RiskDecisionBase<'policy-blocked'> {
  /** Stable machine-readable identifier of the policy rule that vetoed this destination. */
  policyRuleId: string;
  /** The raw evidence decision the policy acted on, if evidence existed at all. */
  underlying?: VerifiedRiskDecision | DegradedRiskDecision | UnscoredRiskDecision;
}

/** The source could not be reached, or the request failed/timed out/was cancelled before evidence was obtained. */
export interface UnavailableRiskDecision extends RiskDecisionBase<'unavailable'> {
  /** Stable machine-readable failure reason. */
  reason: 'timeout' | 'transport-error' | 'cancelled' | (string & {});
}

/**
 * The source's response carries a `schemaVersion` (or otherwise-detected
 * protocol shape) this package does not support. Distinct from
 * `unavailable`: the source answered, but the answer can't be trusted to
 * mean what this contract expects it to mean.
 */
export interface IncompatibleRiskDecision extends RiskDecisionBase<'incompatible'> {
  /** The schema/protocol version actually reported by the source, when known. */
  reportedSchemaVersion?: number;
  /** Human-readable detail for logs/debugging. Never parse this programmatically. */
  detail?: string;
}

/**
 * The full evidence-bearing decision union. Every variant is distinguished
 * by `outcome`; a `switch (decision.outcome)` with no `default` clause is a
 * compile error if any variant is left unhandled (each `case` must return,
 * so an uncovered variant leaves a code path that doesn't — see
 * `tests/type-tests/RiskDecision.type-test.ts`).
 */
export type RiskDecision =
  | VerifiedRiskDecision
  | UnscoredRiskDecision
  | DegradedRiskDecision
  | PolicyBlockedRiskDecision
  | UnavailableRiskDecision
  | IncompatibleRiskDecision;

/** The `outcome` variants that carry a numeric `score` field. */
export type ScoredRiskDecision = VerifiedRiskDecision | DegradedRiskDecision;

/** True when `decision` carries a numeric `score` (`verified` or `degraded`). */
export function isScoredRiskDecision(decision: RiskDecision): decision is ScoredRiskDecision {
  return decision.outcome === 'verified' || decision.outcome === 'degraded';
}
