import { Logger } from './Logger';
import { RiskDecision, RiskDecisionOutcome } from './RiskDecision';

/**
 * Privacy-safe provenance v2 for the {@link RiskDecision} contract.
 *
 * Additive alongside `ProvenanceOracle.ts`'s existing `ScoreProvenance`
 * event — nothing here changes that type or `ProvenanceOracle` itself.
 * This module exists because the audit behind #110 found `ProvenanceOracle`
 * logging full destinations, scores, and stringified errors with no
 * redaction or retention contract: fine for a private, single-tenant log
 * sink, but not something this package should keep defaulting to as more
 * consumers wire up logging. See `PRIVACY_PROVENANCE.md` for the full
 * threat model and retention guidance a sink consuming these events must
 * follow.
 *
 * The default event, with no redaction options overridden, contains:
 *
 * - NO raw destination (an opt-in pseudonymized reference is available
 *   instead — see {@link pseudonymizeDestination} — and the fully raw
 *   destination is a separate, more explicit opt-in on top of that).
 * - NO RPC URLs, issuer keys, or other data embedded in a raw destination
 *   string, for the same reason (they're excluded by exclusion of the
 *   destination itself).
 * - NO raw provider error payloads — only the stable, machine-defined
 *   reason codes already present on `RiskDecision`'s `unavailable`/
 *   `incompatible` variants. A caller with an actual `Error`/unknown
 *   failure object must opt in via `redaction.includeRawError` to attach
 *   anything from it, and even then only a short, capped string.
 *
 * `correlationId` is supplied by the caller (typically a
 * `RequestContext.correlationId`, see `RequestContext.ts`) rather than
 * derived from the destination, so repeated attempts for the same
 * destination within one logical request correlate without the
 * destination itself ever being the join key.
 */

/** This module's schema version. Bump on any breaking change to {@link RiskDecisionProvenanceEvent}'s shape. */
export const RISK_DECISION_PROVENANCE_SCHEMA_VERSION = 1;

/** The type of {@link RISK_DECISION_PROVENANCE_SCHEMA_VERSION}. */
export type RiskDecisionProvenanceSchemaVersion = typeof RISK_DECISION_PROVENANCE_SCHEMA_VERSION;

/**
 * Structured, privacy-safe audit record for one resolved {@link RiskDecision}.
 * See the module doc for exactly what is and isn't in here by default.
 */
export interface RiskDecisionProvenanceEvent {
  /** Discriminant tag identifying this record shape in a log stream. */
  event: 'risk_decision_provenance';
  /** Schema version of this event shape. */
  schemaVersion: RiskDecisionProvenanceSchemaVersion;
  /** Caller-supplied request identity, independent of the destination — see the module doc. */
  correlationId: string;
  /** The decision's outcome discriminant. */
  outcome: RiskDecisionOutcome;
  /** Which oracle/tier produced the decision. */
  source: string;
  /** Epoch ms the underlying evidence was observed/produced (from `RiskDecision.observedAt`). */
  observedAt: number;
  /** Epoch ms this event was emitted. */
  timestamp: number;
  /** Wall-clock duration of the call that produced this decision, ms. */
  latencyMs: number;
  /** The score, when the outcome carries one (`verified`/`degraded`). Scores are not treated as sensitive — they carry no destination/identity information on their own. */
  score?: number;
  /** Stable machine reason code, for outcomes that carry one (`unscored`/`degraded`/`unavailable`/`incompatible`). */
  reason?: string;
  /** Stable machine policy rule id, present only when `outcome` is `"policy-blocked"`. */
  policyRuleId?: string;
  /**
   * Pseudonymized destination reference (see {@link pseudonymizeDestination}).
   * Present only when `redaction.includePseudonymizedDestination` was set;
   * absent by default.
   */
  destinationRef?: string;
  /**
   * The raw destination, verbatim. Present only when
   * `redaction.includeRawDestination` was explicitly set — a strictly
   * stronger opt-in than `destinationRef`, and one that should not be
   * enabled for a sink shared across tenants/users. Absent by default.
   */
  destination?: string;
  /**
   * A short, capped rendering of a raw failure the caller supplied, present
   * only when `redaction.includeRawError` was explicitly set. Absent by
   * default, since provider error text can embed RPC URLs, issuer keys, or
   * other operational detail that isn't safe to log unredacted.
   */
  rawErrorDetail?: string;
}

/** Controls what {@link createRiskDecisionProvenanceEvent} includes beyond the privacy-safe default. Every field defaults to `false` — nothing extra is included unless explicitly opted in. */
export interface RiskDecisionRedactionOptions {
  /** Include a salted, one-way pseudonymized reference to the destination. Requires `destinationSalt`. */
  includePseudonymizedDestination?: boolean;
  /**
   * Salt mixed into the pseudonymized reference. Required when
   * `includePseudonymizedDestination` is `true`. Use a value specific to
   * your deployment (not this package's default, since there is no
   * default) — a fixed, well-known salt makes the pseudonymized reference
   * dictionary-attackable against the small, mostly-public space of real
   * Stellar addresses. See `PRIVACY_PROVENANCE.md`.
   */
  destinationSalt?: string;
  /**
   * Include the raw destination verbatim. Strongly discouraged for a sink
   * shared across tenants/users — see `PRIVACY_PROVENANCE.md`. Off by
   * default.
   */
  includeRawDestination?: boolean;
  /**
   * Include a short, capped rendering of `meta.rawError` (when supplied).
   * Off by default: provider error text can embed RPC URLs, issuer keys,
   * or other operational detail.
   */
  includeRawError?: boolean;
}

/** Non-cryptographic input to {@link createRiskDecisionProvenanceEvent} beyond the decision itself. */
export interface RiskDecisionProvenanceMeta {
  /** Stable request identity — typically a `RequestContext.correlationId`. Never the destination. */
  correlationId: string;
  /** Wall-clock duration of the call that produced `decision`, ms. */
  latencyMs: number;
  /** Clock returning epoch milliseconds. Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** The raw underlying failure, if any — only surfaced when `redaction.includeRawError` is set. */
  rawError?: unknown;
}

const RAW_ERROR_DETAIL_MAX_LENGTH = 200;

/**
 * A lightweight, dependency-free (no `node:crypto`, so this works in a
 * browser/extension runtime too) pseudonymization of a destination: a
 * salted, non-cryptographic hash (FNV-1a), rendered as a short hex string.
 *
 * This is pseudonymization, not encryption or a cryptographic commitment:
 * it is NOT safe against an adversary who can guess candidate destinations
 * and check them against a leaked salt + reference (the space of real
 * Stellar addresses is enumerable/public in exactly the way that matters
 * for this attack). It is intended to let two events for the *same*
 * destination be correlated by a log consumer without that consumer ever
 * seeing the destination itself — not to withstand a targeted
 * de-anonymization attempt. See `PRIVACY_PROVENANCE.md`.
 */
export function pseudonymizeDestination(destination: string, salt: string): string {
  const input = `${salt} ${destination}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `dref_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function capString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function renderRawError(rawError: unknown): string {
  if (rawError instanceof Error) {
    return capString(`${rawError.name}: ${rawError.message}`, RAW_ERROR_DETAIL_MAX_LENGTH);
  }
  return capString(String(rawError), RAW_ERROR_DETAIL_MAX_LENGTH);
}

function outcomeReason(decision: RiskDecision): string | undefined {
  switch (decision.outcome) {
    case 'verified':
      return undefined;
    case 'unscored':
      return decision.reason;
    case 'degraded':
      return decision.degradationReason;
    case 'policy-blocked':
      return undefined;
    case 'unavailable':
      return decision.reason;
    case 'incompatible':
      return decision.detail;
  }
}

function outcomeScore(decision: RiskDecision): number | undefined {
  return decision.outcome === 'verified' || decision.outcome === 'degraded'
    ? decision.score
    : undefined;
}

/**
 * Builds a privacy-safe {@link RiskDecisionProvenanceEvent} for `decision`.
 * See the module doc for exactly what's included by default and how to opt
 * into more via `redaction`.
 */
export function createRiskDecisionProvenanceEvent(
  decision: RiskDecision,
  meta: RiskDecisionProvenanceMeta,
  redaction: RiskDecisionRedactionOptions = {},
): RiskDecisionProvenanceEvent {
  const now = meta.now ?? Date.now;

  const event: RiskDecisionProvenanceEvent = {
    event: 'risk_decision_provenance',
    schemaVersion: RISK_DECISION_PROVENANCE_SCHEMA_VERSION,
    correlationId: meta.correlationId,
    outcome: decision.outcome,
    source: decision.source,
    observedAt: decision.observedAt,
    timestamp: now(),
    latencyMs: meta.latencyMs,
    score: outcomeScore(decision),
    reason: outcomeReason(decision),
    policyRuleId: decision.outcome === 'policy-blocked' ? decision.policyRuleId : undefined,
  };

  if (redaction.includePseudonymizedDestination) {
    if (redaction.destinationSalt === undefined) {
      throw new Error(
        'redaction.destinationSalt is required when redaction.includePseudonymizedDestination is true.',
      );
    }
    event.destinationRef = pseudonymizeDestination(decision.destination, redaction.destinationSalt);
  }

  if (redaction.includeRawDestination) {
    event.destination = decision.destination;
  }

  if (redaction.includeRawError && meta.rawError !== undefined) {
    event.rawErrorDetail = renderRawError(meta.rawError);
  }

  return event;
}

/** Maps a {@link RiskDecisionProvenanceEvent}'s outcome to a `Logger` severity: `error` for unavailable/incompatible, `warn` for degraded/policy-blocked, `info` otherwise. */
export function riskDecisionLogLevel(outcome: RiskDecisionOutcome): 'info' | 'warn' | 'error' {
  switch (outcome) {
    case 'unavailable':
    case 'incompatible':
      return 'error';
    case 'degraded':
    case 'policy-blocked':
      return 'warn';
    case 'verified':
    case 'unscored':
      return 'info';
  }
}

/** Emits `event` through `logger` at the severity {@link riskDecisionLogLevel} assigns its outcome. */
export function emitRiskDecisionProvenance(
  logger: Logger,
  event: RiskDecisionProvenanceEvent,
): void {
  logger[riskDecisionLogLevel(event.outcome)]('risk_decision_provenance', { ...event });
}
