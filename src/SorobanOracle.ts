import { RiskOracle, DetailedRiskOracle, ScoredResult, CacheStatus } from './RiskOracle';
import { CancellableRiskOracle, raceWithCancellation } from './CancellableRiskOracle';
import { validateDestination } from './DestinationValidator';
import { decodeStrKey } from './StrKeyCodec';
import {
  OracleError,
  OracleCancelledError,
  OracleUnavailableError,
  InvalidDestinationError,
  UnrecognizedDestinationError,
  UnsupportedInterfaceVersionError,
  WrongNetworkError,
  WrongContractError,
  MalformedOracleResponseError,
  InsufficientFinalityError,
  ScoreNotYetComputedError,
} from './OracleError';
import {
  SOROBAN_GET_SCORE_METHOD,
  decodeSorobanRawResponse,
  isInterfaceVersionSupported,
  InterfaceVersionRange,
  SorobanScoreRequest,
  SorobanRawResponse,
} from './fixtures/soroban';

/**
 * Deployment environment a {@link SorobanOracle} instance is running in.
 * `'production'` is enforced, not advisory — see
 * {@link SorobanOracleConfig.environment}.
 */
export type SorobanOracleEnvironment = 'production' | 'staging' | 'development' | 'test';

const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'production',
  'staging',
  'development',
  'test',
]);

/** Ledger-checkpoint freshness/finality requirements — see docs/adr/0001-soroban-oracle-protocol.md. */
export interface SorobanFinalityPolicy {
  /**
   * Minimum number of ledgers that must have closed after a result's
   * reported ledger before that result is trusted at all. A result short of
   * this is rejected with {@link InsufficientFinalityError} rather than
   * returned — see the ADR's "Finality policy" section.
   */
  minConfirmations: number;
  /**
   * Maximum age, in milliseconds, between a result's ledger close time and
   * "now" before it's downgraded from `cacheStatus: 'live'` to
   * `cacheStatus: 'cache-stale'`. Unlike `minConfirmations`, exceeding this
   * does not reject the result — see the ADR.
   */
  maxResultAgeMs: number;
}

/**
 * Eagerly-validated configuration for a {@link SorobanOracle} instance. Every
 * field is validated synchronously in the constructor; a bad config throws
 * immediately rather than surfacing as a confusing failure on the first
 * `getScore` call.
 */
export interface SorobanOracleConfig {
  /**
   * Deployment environment this instance is running in. Required, with no
   * default, so the decision is always explicit. When `'production'`, the
   * constructor refuses a {@link SorobanRpcTransport} whose `transportKind`
   * is `'fixture'` — see that field's doc comment.
   */
  environment: SorobanOracleEnvironment;
  /**
   * Network passphrase every response must match (e.g. `Networks.TESTNET` /
   * `Networks.PUBLIC` from `@stellar/stellar-sdk`). A response reporting a
   * different passphrase throws {@link WrongNetworkError}.
   */
  networkPassphrase: string;
  /**
   * Allowlisted RPC endpoint URL(s). This adapter validates the list is
   * non-empty and each entry is a well-formed `http(s)` URL; actually
   * calling (and, eventually, failing over across) these endpoints is the
   * `SorobanRpcTransport` implementation's job — see the ADR's "Scope of
   * this increment".
   */
  rpcEndpoints: readonly string[];
  /**
   * The Soroban contract id (`C...`) this instance targets. A response
   * reporting a different contract id throws {@link WrongContractError}.
   */
  contractId: string;
  /** Interface version range this instance accepts — see {@link UnsupportedInterfaceVersionError}. */
  supportedInterfaceVersionRange: InterfaceVersionRange;
  /** Ledger-checkpoint freshness/finality policy — see {@link SorobanFinalityPolicy}. */
  finalityPolicy: SorobanFinalityPolicy;
  /**
   * Default per-request budget, in milliseconds, passed to the transport.
   * Callers may override it per call via `getScore`'s `options.timeoutMs`.
   */
  requestBudgetMs: number;
}

/**
 * Injectable seam between {@link SorobanOracle} and the actual Soroban RPC
 * network call. This package does not ship a `'live'` implementation of
 * this interface (see docs/adr/0001-soroban-oracle-protocol.md's "Scope of
 * this increment") — only this type, and a deterministic in-memory fake
 * (`tests/support/FakeSorobanRpcTransport.ts`) used by this package's own
 * tests. A real implementation is expected to simulate/invoke `get_score`
 * via `@stellar/stellar-sdk` against one of `SorobanOracleConfig.rpcEndpoints`
 * and decode the XDR result into a plain JS value — `SorobanOracle` itself
 * defensively re-validates that value via `decodeSorobanRawResponse`
 * (src/fixtures/soroban/schema.ts) before trusting any of it.
 */
export interface SorobanRpcTransport {
  /**
   * Discriminates a fixture/in-memory transport from a real network
   * implementation, so a `'production'`-environment `SorobanOracle` can
   * refuse to be constructed with one — see
   * {@link SorobanOracleConfig.environment}. A real transport implementation
   * must set this to `'live'`.
   */
  readonly transportKind: 'live' | 'fixture';
  /**
   * Invokes `get_score` and resolves to the *raw, untrusted* decoded
   * response. `SorobanOracle` validates the return value against
   * {@link SorobanRawResponse}'s schema before using any of it — a transport
   * does not need to pre-validate its own return value.
   *
   * @param options.signal When provided (from `getScoreCancellable` or a
   * `getScore`/`getScoreDetailed` caller's own `options.signal`), the
   * transport must abort its underlying network call once this fires — see
   * `CancellableRiskOracle`'s cancellation contract in
   * src/CancellableRiskOracle.ts, which this method is the resource-owning
   * end of.
   */
  invokeGetScore(
    request: SorobanScoreRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown>;
}

/**
 * `getScoreDetailed`/`getScoreCancellable`'s result shape: a strict superset
 * of {@link ScoredResult} carrying the network/contract/version/ledger
 * metadata needed to judge exactly how a `SorobanOracle` score was produced
 * — see docs/adr/0001-soroban-oracle-protocol.md's "Finality policy" section.
 */
export interface SorobanScoredResult extends ScoredResult {
  /** Network passphrase the response was validated against. */
  networkPassphrase: string;
  /** Contract id the response was validated against. */
  contractId: string;
  /** Interface version the contract reported for this response. */
  interfaceVersion: number;
  /** Ledger sequence the score was computed against. */
  ledgerSequence: number;
  /** Epoch milliseconds at which the reported ledger closed. */
  ledgerCloseTimeUnixMs: number;
  /** Ledgers closed after `ledgerSequence`, as observed by the transport at call time. */
  observedConfirmations: number;
}

const SOURCE = 'SorobanOracle';

function isWellFormedRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateConfig(config: SorobanOracleConfig): void {
  if (!VALID_ENVIRONMENTS.has(config.environment)) {
    throw new RangeError(
      `SorobanOracle: environment must be one of "production"/"staging"/"development"/"test", got ${JSON.stringify(config.environment)}.`,
    );
  }
  if (typeof config.networkPassphrase !== 'string' || config.networkPassphrase.length === 0) {
    throw new RangeError('SorobanOracle: networkPassphrase must be a non-empty string.');
  }
  if (!Array.isArray(config.rpcEndpoints) || config.rpcEndpoints.length === 0) {
    throw new RangeError('SorobanOracle: rpcEndpoints must be a non-empty array of URLs.');
  }
  for (const endpoint of config.rpcEndpoints) {
    if (typeof endpoint !== 'string' || !isWellFormedRpcUrl(endpoint)) {
      throw new RangeError(
        `SorobanOracle: rpcEndpoints entries must be well-formed http(s) URLs, got ${JSON.stringify(endpoint)}.`,
      );
    }
  }
  try {
    decodeStrKey(config.contractId, 'contract');
  } catch (cause) {
    throw new RangeError(
      `SorobanOracle: contractId must be a valid Soroban contract address (C...), got ${JSON.stringify(config.contractId)} (${cause instanceof Error ? cause.message : String(cause)}).`,
      { cause },
    );
  }

  const range = config.supportedInterfaceVersionRange;
  if (
    !range ||
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 1 ||
    range.max < range.min
  ) {
    throw new RangeError(
      'SorobanOracle: supportedInterfaceVersionRange must be { min, max } positive integers with min <= max.',
    );
  }

  const policy = config.finalityPolicy;
  if (!policy || !Number.isInteger(policy.minConfirmations) || policy.minConfirmations < 0) {
    throw new RangeError(
      'SorobanOracle: finalityPolicy.minConfirmations must be a non-negative integer.',
    );
  }
  if (!policy || !(policy.maxResultAgeMs > 0)) {
    throw new RangeError('SorobanOracle: finalityPolicy.maxResultAgeMs must be > 0.');
  }

  if (!(config.requestBudgetMs > 0)) {
    throw new RangeError('SorobanOracle: requestBudgetMs must be > 0.');
  }
}

function validateTransport(
  transport: SorobanRpcTransport,
  environment: SorobanOracleEnvironment,
): void {
  if (
    !transport ||
    typeof transport.invokeGetScore !== 'function' ||
    (transport.transportKind !== 'live' && transport.transportKind !== 'fixture')
  ) {
    throw new TypeError(
      'SorobanOracle: transport must implement SorobanRpcTransport (an invokeGetScore method and a "live"/"fixture" transportKind).',
    );
  }
  if (environment === 'production' && transport.transportKind === 'fixture') {
    throw new Error(
      'SorobanOracle: refusing to construct with a fixture-backed transport while environment is "production". ' +
        'See docs/adr/0001-soroban-oracle-protocol.md\'s "Fixture/stub transports are refused in production" section.',
    );
  }
}

/**
 * Finality-aware client for the Soroban risk-oracle protocol described in
 * docs/adr/0001-soroban-oracle-protocol.md. Implements `RiskOracle`,
 * `DetailedRiskOracle`, and `CancellableRiskOracle` against an injectable
 * {@link SorobanRpcTransport} — this class contains no network code itself
 * (see that interface's doc comment for why).
 *
 * Every failure mode is a distinct, typed error rather than a numeric
 * default: a malformed response throws {@link MalformedOracleResponseError},
 * an interface-version mismatch throws {@link UnsupportedInterfaceVersionError},
 * a wrong-network/wrong-contract response throws {@link WrongNetworkError}/
 * {@link WrongContractError} (checked before any finality logic runs), a
 * not-yet-final result throws {@link InsufficientFinalityError}, and the two
 * "no numeric score" absence variants throw
 * {@link UnrecognizedDestinationError} ("no score exists") or
 * {@link ScoreNotYetComputedError} ("not yet computed") respectively — see
 * the ADR's "Absence semantics" section. This is the direct fix for
 * `StubOracle`'s `DEFAULT_SCORE = 0` fallback: there is no code path here
 * that turns "I don't know" into a number.
 */
export class SorobanOracle implements RiskOracle, DetailedRiskOracle, CancellableRiskOracle {
  private readonly config: Readonly<SorobanOracleConfig>;
  private readonly transport: SorobanRpcTransport;

  constructor(config: SorobanOracleConfig, transport: SorobanRpcTransport) {
    validateConfig(config);
    validateTransport(transport, config.environment);

    this.config = Object.freeze({
      ...config,
      rpcEndpoints: Object.freeze([...config.rpcEndpoints]),
      supportedInterfaceVersionRange: Object.freeze({ ...config.supportedInterfaceVersionRange }),
      finalityPolicy: Object.freeze({ ...config.finalityPolicy }),
    });
    this.transport = transport;
  }

  async getScore(
    destination: string,
    options?: { timeoutMs?: number; signal?: AbortSignal; bypassCache?: boolean },
  ): Promise<number> {
    const result = await this.getScoreDetailed(destination, options);
    return result.score;
  }

  /**
   * @returns A {@link SorobanScoredResult} — a strict superset of
   * `ScoredResult` carrying the network/contract/version/ledger metadata
   * behind the score.
   */
  async getScoreDetailed(
    destination: string,
    options: { timeoutMs?: number; signal?: AbortSignal; bypassCache?: boolean } = {},
  ): Promise<SorobanScoredResult> {
    if (options.signal) {
      if (options.signal.aborted) {
        throw new OracleCancelledError('The oracle request was cancelled.', { destination });
      }
      return raceWithCancellation(
        this.resolve(destination, options.timeoutMs, options.signal),
        options.signal,
        destination,
      );
    }
    return this.resolve(destination, options.timeoutMs, undefined);
  }

  async getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
    if (signal.aborted) {
      throw new OracleCancelledError('The oracle request was cancelled.', { destination });
    }
    const result = await raceWithCancellation(
      this.resolve(destination, undefined, signal),
      signal,
      destination,
    );
    return result.score;
  }

  private async resolve(
    rawDestination: string,
    timeoutMsOverride: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SorobanScoredResult> {
    let validated;
    try {
      validated = validateDestination(rawDestination);
    } catch (error) {
      if (error instanceof InvalidDestinationError) throw error;
      throw new InvalidDestinationError(rawDestination, { cause: error });
    }

    const request: SorobanScoreRequest = {
      method: SOROBAN_GET_SCORE_METHOD,
      destination: validated,
      interfaceVersion: this.config.supportedInterfaceVersionRange.max,
    };
    const timeoutMs = timeoutMsOverride ?? this.config.requestBudgetMs;

    let raw: unknown;
    try {
      raw = await this.transport.invokeGetScore(request, { timeoutMs, signal });
    } catch (error) {
      if (error instanceof OracleError) throw error;
      throw new OracleUnavailableError('The Soroban oracle transport failed.', {
        destination: rawDestination,
        cause: error,
      });
    }

    let response: SorobanRawResponse;
    try {
      response = decodeSorobanRawResponse(raw);
    } catch (cause) {
      throw new MalformedOracleResponseError('Soroban oracle response failed schema validation.', {
        destination: rawDestination,
        cause,
      });
    }

    if (
      !isInterfaceVersionSupported(
        response.interfaceVersion,
        this.config.supportedInterfaceVersionRange,
      )
    ) {
      throw new UnsupportedInterfaceVersionError(
        `Oracle reported interface version ${response.interfaceVersion}, outside the supported range ` +
          `[${this.config.supportedInterfaceVersionRange.min}, ${this.config.supportedInterfaceVersionRange.max}].`,
        {
          destination: rawDestination,
          reportedVersion: response.interfaceVersion,
          supportedRange: { ...this.config.supportedInterfaceVersionRange },
        },
      );
    }

    if (response.networkPassphrase !== this.config.networkPassphrase) {
      throw new WrongNetworkError(
        `Oracle response was for network ${JSON.stringify(response.networkPassphrase)}, expected ${JSON.stringify(this.config.networkPassphrase)}.`,
        {
          destination: rawDestination,
          expectedNetworkPassphrase: this.config.networkPassphrase,
          actualNetworkPassphrase: response.networkPassphrase,
        },
      );
    }

    if (response.contractId !== this.config.contractId) {
      throw new WrongContractError(
        `Oracle response was from contract ${JSON.stringify(response.contractId)}, expected ${JSON.stringify(this.config.contractId)}.`,
        {
          destination: rawDestination,
          expectedContractId: this.config.contractId,
          actualContractId: response.contractId,
        },
      );
    }

    let score: number;
    switch (response.outcome.variant) {
      case 'unscored':
        throw new UnrecognizedDestinationError(rawDestination);
      case 'pending':
        throw new ScoreNotYetComputedError(rawDestination);
      case 'scored':
        score = response.outcome.score;
        break;
    }

    const observedConfirmations = Math.max(
      0,
      response.ledger.latestSeenSequence - response.ledger.sequence,
    );
    if (observedConfirmations < this.config.finalityPolicy.minConfirmations) {
      throw new InsufficientFinalityError(
        `Oracle result at ledger ${response.ledger.sequence} has ${observedConfirmations} confirmation(s), ` +
          `fewer than the required ${this.config.finalityPolicy.minConfirmations}.`,
        {
          destination: rawDestination,
          resultLedgerSequence: response.ledger.sequence,
          observedLedgerSequence: response.ledger.latestSeenSequence,
          requiredConfirmations: this.config.finalityPolicy.minConfirmations,
          observedConfirmations,
        },
      );
    }

    const now = Date.now();
    const ageMs = now - response.ledger.closeTimeUnixMs;
    const cacheStatus: CacheStatus =
      ageMs > this.config.finalityPolicy.maxResultAgeMs ? 'cache-stale' : 'live';

    return {
      score,
      timestamp: now,
      source: SOURCE,
      cacheStatus,
      networkPassphrase: response.networkPassphrase,
      contractId: response.contractId,
      interfaceVersion: response.interfaceVersion,
      ledgerSequence: response.ledger.sequence,
      ledgerCloseTimeUnixMs: response.ledger.closeTimeUnixMs,
      observedConfirmations,
    };
  }
}
