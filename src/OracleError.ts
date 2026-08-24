/**
 * Additional structured information about an oracle failure.
 */
export interface OracleErrorContext {
  /** Destination involved in the failed request, if applicable. */
  destination?: string;

  /** Original error that caused this failure. */
  cause?: unknown;
}

/**
 * Base class for all oracle-related failures.
 *
 * Consumers should prefer checking `instanceof` or `code`
 * instead of parsing error messages.
 */
export class OracleError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: string;

  /** Structured context associated with the failure. */
  public readonly context: Readonly<OracleErrorContext>;

  constructor(message: string, code: string, context: OracleErrorContext = {}) {
    super(message);

    this.name = new.target.name;
    this.code = code;
    this.context = Object.freeze({ ...context });

    if (context.cause !== undefined) {
      this.cause = context.cause;
    }

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The oracle could not be reached. */
export class OracleUnavailableError extends OracleError {
  constructor(message = 'The oracle is unavailable.', context: OracleErrorContext = {}) {
    super(message, 'ORACLE_UNAVAILABLE', context);
  }
}

/** The oracle request timed out. */
export class OracleTimeoutError extends OracleError {
  constructor(message = 'The oracle request timed out.', context: OracleErrorContext = {}) {
    super(message, 'ORACLE_TIMEOUT', context);
  }
}

/**
 * The request was cancelled via an `AbortSignal` (see
 * `CancellableRiskOracle`) before it settled. Distinct from
 * `OracleTimeoutError`: a timeout is this adapter's own budget expiring,
 * while a cancellation is the caller (or a middleware acting on the
 * caller's behalf, e.g. `withTimeout` aborting a cancellable inner oracle)
 * deliberately abandoning the request.
 */
export class OracleCancelledError extends OracleError {
  constructor(message = 'The oracle request was cancelled.', context: OracleErrorContext = {}) {
    super(message, 'ORACLE_CANCELLED', context);
  }
}

/** The supplied destination is invalid. */
export class InvalidDestinationError extends OracleError {
  constructor(destination: string, context: Omit<OracleErrorContext, 'destination'> = {}) {
    super('Invalid destination.', 'INVALID_DESTINATION', {
      ...context,
      destination,
    });
  }
}

/** The destination is valid but not recognized by the oracle. */
export class UnrecognizedDestinationError extends OracleError {
  constructor(destination: string, context: Omit<OracleErrorContext, 'destination'> = {}) {
    super('Destination not recognized.', 'UNRECOGNIZED_DESTINATION', {
      ...context,
      destination,
    });
  }
}

/** The oracle contract is incompatible with this adapter. */
export class ContractIncompatibilityError extends OracleError {
  constructor(message = 'Oracle contract is incompatible.', context: OracleErrorContext = {}) {
    super(message, 'CONTRACT_INCOMPATIBILITY', context);
  }
}

/** Structured context describing why an aggregation could not reach quorum. */
export interface QuorumNotMetContext extends OracleErrorContext {
  /** Successful responses required before the aggregate can be produced. */
  required: number;
  /** Successful responses actually received before the decision was made. */
  succeeded: number;
  /** Total number of sources configured on the aggregator. */
  total: number;
  /** Source label -> stringified failure, for sources that failed or timed out in time to count. */
  failures?: Readonly<Record<string, string>>;
}

/**
 * Fewer than the configured quorum of sources answered successfully
 * (including the zero-successful-sources case) before the aggregator gave
 * up. Thrown by {@link RiskOracleAggregator}.
 */
export class QuorumNotMetError extends OracleError {
  declare public readonly context: Readonly<QuorumNotMetContext>;

  constructor(destination: string, context: Omit<QuorumNotMetContext, 'destination'>) {
    super(
      `Only ${context.succeeded}/${context.required} required source(s) answered ` +
        `successfully for "${destination}" (${context.total} configured).`,
      'QUORUM_NOT_MET',
      { ...context, destination },
    );
  }
}

/** Structured context describing why a `RiskDecision` failed runtime validation. */
export interface RiskDecisionValidationContext extends OracleErrorContext {
  /** Dotted path of the field that failed validation, e.g. `"confidence"` or `"underlying.score"`. */
  field: string;
  /**
   * The offending value, stringified defensively (never the raw value
   * itself, so a malformed/hostile payload can't smuggle an unbounded or
   * sensitive object into an error that a caller might log).
   */
  value?: string;
}

/**
 * A value handed to {@link validateRiskDecision} does not conform to the
 * `RiskDecision` contract — a required field is missing, a field has the
 * wrong type or is out of range, or the payload is internally contradictory
 * (e.g. an `unscored` outcome carrying a numeric `score`). Thrown instead of
 * silently coercing or dropping the offending field, so callers at a trust
 * boundary (a third-party source, a cache, an aggregator) reject malformed
 * evidence rather than accepting it.
 */
export class RiskDecisionValidationError extends OracleError {
  declare public readonly context: Readonly<RiskDecisionValidationContext>;

  constructor(message: string, context: RiskDecisionValidationContext) {
    super(message, 'RISK_DECISION_INVALID', context);
  }
}

/** Structured context describing a rejected cache-control request. */
export interface CacheControlUnsupportedContext extends OracleErrorContext {
  /** Which cache-control intent could not be honored. */
  control: 'bypassCache' | 'revalidate';
}

/**
 * A caller requested cache-control behavior (`bypassCache` or `revalidate`
 * on a {@link RequestContext}) that the callee cannot honor. Thrown rather
 * than silently ignoring the request, per the request-context contract's
 * "honored or explicitly rejected, never silently ignored" rule.
 */
export class CacheControlUnsupportedError extends OracleError {
  declare public readonly context: Readonly<CacheControlUnsupportedContext>;

  constructor(context: CacheControlUnsupportedContext) {
    super(
      `Cache-control intent "${context.control}" is not supported here.`,
      'CACHE_CONTROL_UNSUPPORTED',
      context,
    );
  }
}
