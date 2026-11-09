import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { SorobanRpcTransport } from './SorobanOracle';
import type { SorobanScoreRequest } from './fixtures/soroban';
import type { ValidatedDestination } from './DestinationValidator';
import { decodeStrKey } from './StrKeyCodec';
import {
  ContractIncompatibilityError,
  MalformedOracleResponseError,
  OracleCancelledError,
  OracleError,
  OracleTimeoutError,
  OracleUnavailableError,
  WrongNetworkError,
} from './OracleError';

/**
 * Source account for read-only simulation. Simulation never signs or
 * submits, so the account doesn't need to exist; this is the same all-zero
 * account the SDK's own contract client uses for reads.
 */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * The subset of `rpc.Server` this transport calls. Pass your own (a
 * configured `rpc.Server`, or a test double) through
 * {@link StellarRpcTransportOptions.client}.
 */
export interface StellarRpcClient {
  /** Resolves to the node's network; called once per transport and cached. */
  getNetwork(): Promise<{
    /** The node's network passphrase. */
    passphrase: string;
  }>;
  /** Simulates `tx` (a read-only `get_score` call) without submitting it. */
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

/** Construction options for {@link StellarRpcTransport}. */
export interface StellarRpcTransportOptions {
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl: string;
  /** The risk-oracle contract (`C…`) to call. */
  contractId: string;
  /**
   * The network you expect `rpcUrl` to be on. When set, the transport
   * checks it against the node's `getNetwork` answer before simulating, and
   * throws {@link WrongNetworkError} on a mismatch. (`SorobanOracle` makes
   * the same check on every response either way.)
   */
  networkPassphrase?: string;
  /** Allow a plain-`http` `rpcUrl`, for a local quickstart node. Defaults to `false`. */
  allowHttp?: boolean;
  /** Replaces the `rpc.Server` the transport would otherwise create. */
  client?: StellarRpcClient;
}

/**
 * The real network `SorobanRpcTransport`. It calls the risk-oracle
 * contract's read-only `get_score` through Soroban RPC
 * `simulateTransaction` (nothing is signed, submitted, or paid for) and
 * decodes the result into the `SorobanRawResponse` shape that
 * `SorobanOracle` validates. The contract interface it speaks is documented
 * in contract/README.md.
 *
 * Failures surface as `OracleError`s:
 * - RPC unreachable, HTTP or JSON-RPC errors, or an archived entry:
 *   `OracleUnavailableError`
 * - `timeoutMs` elapsed: `OracleTimeoutError`
 * - `signal` aborted: `OracleCancelledError`
 * - the node reports a different network than `networkPassphrase`:
 *   `WrongNetworkError`
 * - no contract at `contractId`, no `get_score` function, or an argument
 *   shape the contract rejects: `ContractIncompatibilityError`
 * - a return value that isn't `(Score, LedgerStamp, u32)`:
 *   `MalformedOracleResponseError`
 *
 * `rpc.Server` can't cancel an in-flight HTTP request. On timeout or abort
 * the transport stops waiting and rejects straight away, and the late
 * response is discarded.
 */
export class StellarRpcTransport implements SorobanRpcTransport {
  readonly transportKind = 'live' as const;

  private readonly client: StellarRpcClient;
  private readonly contract: Contract;
  private networkPassphrase: Promise<string> | undefined;

  constructor(private readonly options: StellarRpcTransportOptions) {
    let url: URL;
    try {
      url = new URL(options.rpcUrl);
    } catch (cause) {
      throw new RangeError(
        `StellarRpcTransport: rpcUrl must be a URL, got ${JSON.stringify(options.rpcUrl)}.`,
        {
          cause,
        },
      );
    }
    if (url.protocol === 'http:' && !options.allowHttp && !options.client) {
      throw new RangeError(
        'StellarRpcTransport: refusing a plain-http rpcUrl; pass allowHttp: true for a local node.',
      );
    }
    try {
      decodeStrKey(options.contractId, 'contract');
    } catch (cause) {
      throw new RangeError(
        `StellarRpcTransport: contractId must be a C… contract address, got ${JSON.stringify(options.contractId)}.`,
        { cause },
      );
    }
    this.contract = new Contract(options.contractId);
    this.client =
      options.client ?? new rpc.Server(options.rpcUrl, { allowHttp: options.allowHttp ?? false });
  }

  invokeGetScore(
    request: SorobanScoreRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const destination = request.destination.canonical;
    return withDeadline(
      this.call(request).catch((error: unknown) => {
        if (error instanceof OracleError) throw error;
        throw new OracleUnavailableError(`Soroban RPC request failed: ${messageOf(error)}`, {
          destination,
          cause: error,
        });
      }),
      options.timeoutMs,
      options.signal,
      destination,
    );
  }

  private async call(request: SorobanScoreRequest): Promise<unknown> {
    const destination = request.destination.canonical;
    const passphrase = await this.network(destination);

    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(this.contract.call(request.method, encodeTarget(request.destination)))
      .setTimeout(30)
      .build();

    const simulation = await this.client.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      throw simulationError(simulation.error, this.options.contractId, destination);
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new OracleUnavailableError(
        'The score entry is archived on-chain and must be restored before it can be read.',
        { destination },
      );
    }
    const retval = simulation.result?.retval;
    if (!retval) {
      throw new MalformedOracleResponseError('Simulation returned no value for get_score.', {
        destination,
      });
    }

    let native: unknown;
    try {
      native = scValToNative(retval);
    } catch (cause) {
      throw new MalformedOracleResponseError('Could not decode the get_score return value.', {
        destination,
        cause,
      });
    }
    return toRawResponse(native, {
      networkPassphrase: passphrase,
      contractId: this.options.contractId,
      latestLedger: simulation.latestLedger,
      destination,
    });
  }

  /** The node's network passphrase, fetched once and cached. A failed fetch isn't cached. */
  private async network(destination: string): Promise<string> {
    this.networkPassphrase ??= this.client.getNetwork().then(
      (n) => n.passphrase,
      (error: unknown) => {
        this.networkPassphrase = undefined;
        throw error;
      },
    );
    const actual = await this.networkPassphrase;
    const expected = this.options.networkPassphrase;
    if (expected !== undefined && actual !== expected) {
      throw new WrongNetworkError(
        `RPC ${this.options.rpcUrl} is on network ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`,
        { destination, expectedNetworkPassphrase: expected, actualNetworkPassphrase: actual },
      );
    }
    return actual;
  }
}

function enumVariant(name: string, ...values: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...values]);
}

/**
 * Encodes a destination as the contract's `Target` enum. Muxed accounts
 * are scored under their base `G` account; that is already their
 * `canonical` form.
 */
export function encodeTarget(destination: ValidatedDestination): xdr.ScVal {
  switch (destination.kind) {
    case 'account':
    case 'muxedAccount':
    case 'contract':
      return enumVariant('Address', new Address(destination.canonical).toScVal());
    case 'asset':
      return enumVariant(
        'Asset',
        xdr.ScVal.scvString(destination.assetCode),
        new Address(destination.issuer).toScVal(),
      );
    case 'liquidityPool':
      return enumVariant(
        'Pool',
        nativeToScVal(decodeStrKey(destination.canonical, 'liquidityPool').payload, {
          type: 'bytes',
        }),
      );
  }
}

function decodeOutcome(value: unknown): { variant: string; score?: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 2 && value[0] === 'Scored') {
    return { variant: 'scored', score: value[1] as number };
  }
  if (value.length === 1 && value[0] === 'Pending') return { variant: 'pending' };
  if (value.length === 1 && value[0] === 'Unscored') return { variant: 'unscored' };
  return undefined;
}

function toRawResponse(
  native: unknown,
  ctx: { networkPassphrase: string; contractId: string; latestLedger: number; destination: string },
): unknown {
  const malformed = (detail: string): MalformedOracleResponseError =>
    new MalformedOracleResponseError(
      `get_score returned an unexpected value (${detail}); expected (Score, LedgerStamp, u32).`,
      { destination: ctx.destination },
    );

  if (!Array.isArray(native) || native.length !== 3) throw malformed('not a 3-tuple');
  const [score, stamp, interfaceVersion] = native as [unknown, unknown, unknown];
  const outcome = decodeOutcome(score);
  if (!outcome) throw malformed('unknown Score variant');
  if (typeof stamp !== 'object' || stamp === null) throw malformed('LedgerStamp is not a struct');
  const { sequence, timestamp } = stamp as { sequence?: unknown; timestamp?: unknown };
  if (typeof timestamp !== 'bigint' && typeof timestamp !== 'number') {
    throw malformed('LedgerStamp.timestamp is not an integer');
  }

  // Everything past this point is range-checked by decodeSorobanRawResponse.
  return {
    interfaceVersion,
    networkPassphrase: ctx.networkPassphrase,
    contractId: ctx.contractId,
    ledger: {
      sequence,
      closeTimeUnixMs: Number(timestamp) * 1000,
      latestSeenSequence: ctx.latestLedger,
    },
    outcome,
  };
}

/** Simulation errors that mean "this contract doesn't speak the protocol", not "try again". */
const INCOMPATIBLE =
  /Error\((?:Storage|WasmVm|Value|Object), (?:MissingValue|InvalidAction|UnexpectedType|InvalidInput)\)/;

function simulationError(message: string, contractId: string, destination: string): OracleError {
  const summary = message.split('\n')[0];
  if (/non-existing value for contract instance/.test(message)) {
    return new ContractIncompatibilityError(
      `No contract instance at ${contractId} on this network (wrong contractId or network?): ${summary}`,
      { destination },
      'CONTRACT_NOT_FOUND',
    );
  }
  if (INCOMPATIBLE.test(message)) {
    return new ContractIncompatibilityError(
      `Contract ${contractId} rejected get_score: ${summary}`,
      { destination },
    );
  }
  return new OracleUnavailableError(`get_score simulation failed: ${summary}`, { destination });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  destination: string,
): Promise<T> {
  if (signal?.aborted) {
    work.catch(() => {});
    return Promise.reject(
      new OracleCancelledError('The oracle request was cancelled.', { destination }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new OracleCancelledError('The oracle request was cancelled.', { destination }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new OracleTimeoutError(`Soroban RPC did not answer within ${timeoutMs} ms.`, {
          destination,
        }),
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
