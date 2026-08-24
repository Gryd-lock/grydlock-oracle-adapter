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
  constructor(
    message = 'Oracle contract is incompatible.',
    context: OracleErrorContext = {},
    code = 'CONTRACT_INCOMPATIBILITY',
  ) {
    super(message, code, context);
  }
}

/** Structured context for an interface-version mismatch. */
export interface UnsupportedInterfaceVersionContext extends OracleErrorContext {
  /** Interface version the oracle actually reported. */
  reportedVersion: number;
  /** The range this adapter instance was configured to accept. */
  supportedRange: {
    /** Minimum interface version accepted, inclusive. */
    min: number;
    /** Maximum interface version accepted, inclusive. */
    max: number;
  };
}

/**
 * The oracle contract reported an interface version outside the range this
 * `SorobanOracle` instance was configured to support (see
 * `SorobanOracleConfig.supportedInterfaceVersionRange`). A specialization of
 * {@link ContractIncompatibilityError} — every `UnsupportedInterfaceVersionError`
 * is a `ContractIncompatibilityError`, so existing `instanceof
 * ContractIncompatibilityError` handling keeps working, while callers that
 * care about the specific reason can check `instanceof
 * UnsupportedInterfaceVersionError` or `code === 'UNSUPPORTED_INTERFACE_VERSION'`.
 */
export class UnsupportedInterfaceVersionError extends ContractIncompatibilityError {
  declare public readonly context: Readonly<UnsupportedInterfaceVersionContext>;

  constructor(message: string, context: UnsupportedInterfaceVersionContext) {
    super(message, context, 'UNSUPPORTED_INTERFACE_VERSION');
  }
}

/** Structured context for a response answered on the wrong network. */
export interface WrongNetworkContext extends OracleErrorContext {
  /** Network passphrase this adapter instance is configured to require. */
  expectedNetworkPassphrase: string;
  /** Network passphrase the response actually reported. */
  actualNetworkPassphrase: string;
}

/**
 * The oracle response reported a network passphrase other than the one this
 * `SorobanOracle` instance is configured for. Rejected before any
 * finality/caching logic runs — see docs/adr/0001-soroban-oracle-protocol.md.
 */
export class WrongNetworkError extends OracleError {
  declare public readonly context: Readonly<WrongNetworkContext>;

  constructor(
    message = 'Oracle response was for the wrong network.',
    context: WrongNetworkContext,
  ) {
    super(message, 'WRONG_NETWORK', context);
  }
}

/** Structured context for a response answered by the wrong contract. */
export interface WrongContractContext extends OracleErrorContext {
  /** Contract id this adapter instance is configured to require. */
  expectedContractId: string;
  /** Contract id the response actually reported. */
  actualContractId: string;
}

/**
 * The oracle response reported a contract id other than the one this
 * `SorobanOracle` instance is configured for. Rejected before any
 * finality/caching logic runs — see docs/adr/0001-soroban-oracle-protocol.md.
 */
export class WrongContractError extends OracleError {
  declare public readonly context: Readonly<WrongContractContext>;

  constructor(
    message = 'Oracle response was for the wrong contract.',
    context: WrongContractContext,
  ) {
    super(message, 'WRONG_CONTRACT', context);
  }
}

/** The oracle's response could not be decoded against the expected protocol schema. */
export class MalformedOracleResponseError extends OracleError {
  constructor(message = 'Oracle response is malformed.', context: OracleErrorContext = {}) {
    super(message, 'MALFORMED_ORACLE_RESPONSE', context);
  }
}

/** Structured context for a result rejected by the finality policy. */
export interface InsufficientFinalityContext extends OracleErrorContext {
  /** Ledger sequence the score was computed against. */
  resultLedgerSequence: number;
  /** Most recent ledger sequence the transport observed at response time. */
  observedLedgerSequence: number;
  /** Confirmations required by the configured finality policy. */
  requiredConfirmations: number;
  /** Confirmations actually observed (`observedLedgerSequence - resultLedgerSequence`, floored at 0). */
  observedConfirmations: number;
}

/**
 * The oracle answered, but the reported ledger checkpoint has not yet
 * accumulated the confirmations required by the configured finality policy
 * (`SorobanOracleConfig.finalityPolicy.minConfirmations`). Thrown instead of
 * returning the not-yet-final result, so a result that might still be
 * superseded is never treated as authoritative — see
 * docs/adr/0001-soroban-oracle-protocol.md's "Finality policy" section.
 * Distinct from a `'cache-stale'`-labeled `SorobanScoredResult`: staleness
 * means the (fully final) data is simply old, while insufficient finality
 * means the data isn't safely usable yet at all.
 */
export class InsufficientFinalityError extends OracleError {
  declare public readonly context: Readonly<InsufficientFinalityContext>;

  constructor(
    message = 'Oracle result has not reached the required finality.',
    context: InsufficientFinalityContext,
  ) {
    super(message, 'INSUFFICIENT_FINALITY', context);
  }
}

/**
 * The destination is tracked by the oracle, but a score has not been
 * computed for it yet (`outcome.variant === 'pending'` — see
 * docs/adr/0001-soroban-oracle-protocol.md's "Absence semantics" section).
 * Distinct from {@link UnrecognizedDestinationError} (the oracle has
 * considered the destination and deliberately has no score to report, a
 * permanent answer) and from {@link OracleUnavailableError}/
 * {@link OracleTimeoutError} (the adapter could not get any answer at all).
 */
export class ScoreNotYetComputedError extends OracleError {
  constructor(destination: string, context: Omit<OracleErrorContext, 'destination'> = {}) {
    super('Score has not been computed for this destination yet.', 'SCORE_NOT_YET_COMPUTED', {
      ...context,
      destination,
    });
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
