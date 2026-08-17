import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { validateDestination } from './DestinationValidator';
import { Logger, noopLogger } from './Logger';
import {
  ContractIncompatibilityError,
  OracleError,
  OracleTimeoutError,
  OracleUnavailableError,
  UnrecognizedDestinationError,
} from './OracleError';
import { DetailedRiskOracle, ScoredResult } from './RiskOracle';

/** Default per-call budget for a single `get_score` simulation. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Source of a {@link SorobanOracle} score — distinct from other sources such
 * as `StubOracle` or a fallback tier.
 */
export const SOROBAN_SOURCE = 'soroban';

/**
 * Configuration for {@link SorobanOracle}.
 */
export interface SorobanOracleOptions {
  /** Base URL of the Soroban RPC endpoint, e.g. `http://127.0.0.1:8000`. */
  rpcUrl: string;
  /** Contract ID (`C...`) of the deployed risk-oracle contract. */
  contractId: string;
  /**
   * Network passphrase used when building the simulation transaction.
   * Defaults to the public network passphrase; use `Networks.STANDALONE` when
   * talking to a local standalone Soroban environment.
   */
  networkPassphrase?: string;
  /** Per-call timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** Optional structured logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Read-only client for the on-chain risk-oracle Soroban contract.
 *
 * Calls `get_score(destination)` on the configured contract via Soroban RPC
 * `simulateTransaction`, decodes the returned score, and maps failures to the
 * shared {@link OracleError} hierarchy:
 *
 * - malformed destinations → {@link InvalidDestinationError}
 * - valid destinations the contract does not recognize → {@link UnrecognizedDestinationError}
 * - an unreachable or failing RPC endpoint → {@link OracleUnavailableError}
 * - a response that did not settle within the budget → {@link OracleTimeoutError}
 * - a success response that does not carry a numeric 0-100 score → {@link ContractIncompatibilityError}
 *
 * The contract is read-only: `get_score` is simulated, never submitted, so no
 * transaction is sent to the network and no signing keys are required.
 */
export class SorobanOracle implements DetailedRiskOracle {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly account: Account;
  private readonly networkPassphrase: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: SorobanOracleOptions) {
    if (!options.rpcUrl) {
      throw new TypeError('SorobanOracle requires a non-empty `rpcUrl`');
    }
    if (!options.contractId) {
      throw new TypeError('SorobanOracle requires a non-empty `contractId`');
    }

    this.server = new rpc.Server(options.rpcUrl, { allowHttp: true });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase ?? Networks.PUBLIC;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? noopLogger;

    // A deterministic throwaway source account: `simulateTransaction` does not
    // need the account to exist on-chain, only a well-formed public key and
    // sequence number to embed in the envelope.
    this.account = new Account(Keypair.fromRawEd25519Seed(new Uint8Array(32)).publicKey(), '0');
  }

  /** Resolves the score for `destination`. */
  async getScore(destination: string): Promise<number> {
    return (await this.getScoreDetailed(destination)).score;
  }

  /** Resolves the score for `destination` plus provenance metadata. */
  async getScoreDetailed(destination: string): Promise<ScoredResult> {
    const timestamp = Date.now();
    const { canonical } = validateDestination(destination);

    try {
      const simulation = await this.simulate(canonical);

      if (rpc.Api.isSimulationError(simulation)) {
        this.logger.debug('Soroban contract rejected the destination', {
          destination: canonical,
          error: simulation.error,
        });
        throw new UnrecognizedDestinationError(canonical, {
          cause: new Error(simulation.error),
        });
      }

      if (!simulation.result) {
        throw new ContractIncompatibilityError(
          'Simulation returned no result for the invocation.',
          { destination: canonical },
        );
      }

      const score = this.decodeScore(simulation.result.retval, canonical);

      return {
        score,
        timestamp,
        source: SOROBAN_SOURCE,
        cacheStatus: 'live',
      };
    } catch (err) {
      if (err instanceof OracleError) {
        throw err;
      }
      throw new OracleUnavailableError(undefined, { destination: canonical, cause: err });
    }
  }

  /**
   * Builds and simulates the `get_score` invocation for `destination`.
   */
  private async simulate(destination: string): Promise<rpc.Api.SimulateTransactionResponse> {
    const operation = this.contract.call(
      'get_score',
      nativeToScVal(destination, { type: 'string' }),
    );
    const transaction = new TransactionBuilder(this.account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(0)
      .build();

    return this.withTimeout(() => this.server.simulateTransaction(transaction));
  }

  /**
   * Converts the returned {@link xdr.ScVal} into a 0-100 integer score.
   *
   * @throws {ContractIncompatibilityError} If the return value is not an
   * integer in the inclusive 0-100 range (i.e. the contract is not the
   * expected risk-oracle shape).
   */
  private decodeScore(retval: xdr.ScVal, destination: string): number {
    const native = scValToNative(retval);

    let score: number;
    if (typeof native === 'bigint') {
      score = Number(native);
    } else if (typeof native === 'number' && Number.isInteger(native)) {
      score = native;
    } else {
      throw new ContractIncompatibilityError(`Expected a numeric score, got ${typeof native}.`, {
        destination,
      });
    }

    if (score < 0 || score > 100) {
      throw new ContractIncompatibilityError(`Score ${score} is outside the 0-100 risk range.`, {
        destination,
      });
    }

    return score;
  }

  /**
   * Rejects with {@link OracleTimeoutError} if `task` does not settle within
   * the configured budget. The abandoned call is detached and its late
   * rejection silenced, since `RiskOracle` does not yet accept an
   * `AbortSignal`.
   */
  private async withTimeout<T>(task: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inner = task();
    try {
      return await Promise.race([
        inner,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new OracleTimeoutError(`getScore timed out after ${this.timeoutMs}ms.`)),
            this.timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof OracleTimeoutError) {
        inner.catch(() => {});
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
