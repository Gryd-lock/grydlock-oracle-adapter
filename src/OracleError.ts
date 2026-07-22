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
  
    constructor(
      message: string,
      code: string,
      context: OracleErrorContext = {},
    ) {
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
    constructor(
      message = 'The oracle is unavailable.',
      context: OracleErrorContext = {},
    ) {
      super(message, 'ORACLE_UNAVAILABLE', context);
    }
  }
  
  /** The oracle request timed out. */
  export class OracleTimeoutError extends OracleError {
    constructor(
      message = 'The oracle request timed out.',
      context: OracleErrorContext = {},
    ) {
      super(message, 'ORACLE_TIMEOUT', context);
    }
  }
  
  /** The supplied destination is invalid. */
  export class InvalidDestinationError extends OracleError {
    constructor(
      destination: string,
      context: Omit<OracleErrorContext, 'destination'> = {},
    ) {
      super('Invalid destination.', 'INVALID_DESTINATION', {
        ...context,
        destination,
      });
    }
  }
  
  /** The destination is valid but not recognized by the oracle. */
  export class UnrecognizedDestinationError extends OracleError {
    constructor(
      destination: string,
      context: Omit<OracleErrorContext, 'destination'> = {},
    ) {
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
    ) {
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