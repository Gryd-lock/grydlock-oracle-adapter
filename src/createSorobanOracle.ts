import {
  SorobanOracle,
  SorobanOracleEnvironment,
  SorobanFinalityPolicy,
  SorobanOracleConfig,
} from './SorobanOracle';
import { StellarRpcTransport, StellarRpcClient } from './StellarRpcTransport';
import { SOROBAN_ORACLE_INTERFACE_VERSION_RANGE } from './fixtures/soroban';

/** Where a {@link SorobanOracle} reads from: the network, its RPC, and the contract. */
export interface SorobanNetworkTarget {
  /** The network passphrase every response must match. */
  readonly networkPassphrase: string;
  /** Soroban RPC endpoint. */
  readonly rpcUrl: string;
  /** The risk-oracle contract (`C…`). */
  readonly contractId: string;
}

/**
 * The reference risk-oracle contract on Stellar testnet, seeded with
 * grydlock-testkit's scores. It is for development and evaluation only:
 * one admin curates it by hand. See contract/README.md and
 * contract/deployments/testnet.json.
 */
export const GRYDLOCK_TESTNET: SorobanNetworkTarget = Object.freeze({
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: 'CA42XDMAPI3QXA4XP6HEBPWD3IHZQ3YJB4MABSURASGGOVYU5QCWSC2M',
});

/** Default finality policy used by {@link createSorobanOracle}. */
export const DEFAULT_SOROBAN_FINALITY_POLICY: SorobanFinalityPolicy = Object.freeze({
  minConfirmations: 1,
  maxResultAgeMs: 7 * 24 * 60 * 60 * 1000,
});

/** Options for {@link createSorobanOracle}. */
export interface CreateSorobanOracleOptions extends SorobanNetworkTarget {
  /** Required, with no default. See {@link SorobanOracleConfig.environment}. */
  environment: SorobanOracleEnvironment;
  /** Defaults to {@link DEFAULT_SOROBAN_FINALITY_POLICY}. */
  finalityPolicy?: SorobanFinalityPolicy;
  /** Per-request budget in milliseconds. Defaults to 10 000. */
  requestBudgetMs?: number;
  /** Allow a plain-`http` `rpcUrl` (local node). */
  allowHttp?: boolean;
  /** Replaces the `rpc.Server` the transport would otherwise create (tests, custom headers). */
  client?: StellarRpcClient;
}

/**
 * Builds a {@link SorobanOracle} wired to a live {@link StellarRpcTransport}.
 *
 * @example
 * ```ts
 * const oracle = createSorobanOracle({ ...GRYDLOCK_TESTNET, environment: 'development' });
 * const result = await oracle.getScoreDetailed('GD7XPB2A7CG5Z4ICV24B3LXCRHAEJRFEK4OEW3ZIOQAPJOHAXBB7QHGE');
 * ```
 */
export function createSorobanOracle(options: CreateSorobanOracleOptions): SorobanOracle {
  const config: SorobanOracleConfig = {
    environment: options.environment,
    networkPassphrase: options.networkPassphrase,
    rpcEndpoints: [options.rpcUrl],
    contractId: options.contractId,
    supportedInterfaceVersionRange: SOROBAN_ORACLE_INTERFACE_VERSION_RANGE,
    finalityPolicy: options.finalityPolicy ?? DEFAULT_SOROBAN_FINALITY_POLICY,
    requestBudgetMs: options.requestBudgetMs ?? 10_000,
  };
  const transport = new StellarRpcTransport({
    rpcUrl: options.rpcUrl,
    contractId: options.contractId,
    networkPassphrase: options.networkPassphrase,
    allowHttp: options.allowHttp,
    client: options.client,
  });
  return new SorobanOracle(config, transport);
}
