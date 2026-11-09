import { describe, expect, it } from 'vitest';
import { Address, nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import {
  ContractIncompatibilityError,
  MalformedOracleResponseError,
  OracleCancelledError,
  OracleTimeoutError,
  OracleUnavailableError,
  ScoreNotYetComputedError,
  SorobanOracle,
  StellarRpcTransport,
  UnrecognizedDestinationError,
  WrongNetworkError,
  createSorobanOracle,
  encodeSorobanTarget,
  validateDestination,
  decodeStrKey,
  encodeStrKey,
} from '../src';
import type { StellarRpcClient } from '../src';

const TESTNET = 'Test SDF Network ; September 2015';
const CONTRACT = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const ACCOUNT = 'GD7XPB2A7CG5Z4ICV24B3LXCRHAEJRFEK4OEW3ZIOQAPJOHAXBB7QHGE';
const ISSUER = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

function variant(name: string, ...values: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...values]);
}

function stamp(sequence: number, timestampSecs: number): xdr.ScVal {
  return nativeToScVal(
    { sequence, timestamp: BigInt(timestampSecs) },
    { type: { sequence: ['symbol', 'u32'], timestamp: ['symbol', 'u64'] } },
  );
}

function retval(score: xdr.ScVal, sequence = 100, timestampSecs = nowSecs(), version = 1) {
  return xdr.ScVal.scvVec([score, stamp(sequence, timestampSecs), xdr.ScVal.scvU32(version)]);
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function success(value: xdr.ScVal, latestLedger = 110): rpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: '0',
    result: { auth: [], retval: value },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function simError(error: string): rpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 110,
    events: [],
    _parsed: true,
    error,
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

class FakeClient implements StellarRpcClient {
  readonly sent: Transaction[] = [];
  networkCalls = 0;
  constructor(
    private readonly respond: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>,
    private passphrase = TESTNET,
  ) {}
  async getNetwork(): Promise<{ passphrase: string }> {
    this.networkCalls++;
    return { passphrase: this.passphrase };
  }
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    this.sent.push(tx);
    return this.respond(tx);
  }
}

function sentArgs(tx: Transaction): unknown[] {
  const op = tx.toEnvelope().v1().tx().operations()[0];
  const invoke = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
  expect(invoke.functionName().toString()).toBe('get_score');
  expect(Address.fromScAddress(invoke.contractAddress()).toString()).toBe(CONTRACT);
  return invoke.args().map((arg) => scValToNative(arg));
}

function oracle(client: StellarRpcClient, overrides: { minConfirmations?: number } = {}) {
  return createSorobanOracle({
    environment: 'test',
    networkPassphrase: TESTNET,
    rpcUrl: 'https://rpc.invalid',
    contractId: CONTRACT,
    finalityPolicy: {
      minConfirmations: overrides.minConfirmations ?? 1,
      maxResultAgeMs: 60_000,
    },
    client,
  });
}

describe('StellarRpcTransport', () => {
  it('decodes a scored (Score, LedgerStamp, u32) tuple into a SorobanScoredResult', async () => {
    const closed = nowSecs() - 5;
    const client = new FakeClient(async () =>
      success(retval(variant('Scored', xdr.ScVal.scvU32(92)), 100, closed), 110),
    );
    const result = await oracle(client).getScoreDetailed(ACCOUNT);
    expect(result).toMatchObject({
      score: 92,
      source: 'SorobanOracle',
      cacheStatus: 'live',
      networkPassphrase: TESTNET,
      contractId: CONTRACT,
      interfaceVersion: 1,
      ledgerSequence: 100,
      ledgerCloseTimeUnixMs: closed * 1000,
      observedConfirmations: 10,
    });
    expect(sentArgs(client.sent[0])).toEqual([['Address', ACCOUNT]]);
  });

  it('reports an old ledger as cache-stale', async () => {
    const client = new FakeClient(async () =>
      success(retval(variant('Scored', xdr.ScVal.scvU32(4)), 100, nowSecs() - 3600)),
    );
    expect((await oracle(client).getScoreDetailed(ACCOUNT)).cacheStatus).toBe('cache-stale');
  });

  it('maps Unscored and Pending to their typed errors, never to a number', async () => {
    let next = variant('Unscored');
    const client = new FakeClient(async () => success(retval(next)));
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toBeInstanceOf(
      UnrecognizedDestinationError,
    );
    next = variant('Pending');
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toBeInstanceOf(ScoreNotYetComputedError);
  });

  it('encodes assets, muxed accounts, contracts and pools as the contract Target enum', () => {
    const enc = (d: string): unknown => scValToNative(encodeSorobanTarget(validateDestination(d)));
    expect(enc(`SCAM:${ISSUER}`)).toEqual(['Asset', 'SCAM', ISSUER]);
    expect(enc(CONTRACT)).toEqual(['Address', CONTRACT]);
    const accountKey = decodeStrKey(ACCOUNT, 'ed25519PublicKey').payload;
    const muxed = encodeStrKey(
      'med25519PublicKey',
      new Uint8Array([...accountKey, 0, 0, 0, 0, 0, 0, 0, 7]),
    );
    expect(enc(muxed)).toEqual(['Address', ACCOUNT]);
    const poolId = new Uint8Array(32).fill(9);
    const [tag, bytes] = enc(encodeStrKey('liquidityPool', poolId)) as [string, Uint8Array];
    expect(tag).toBe('Pool');
    expect([...bytes]).toEqual([...poolId]);
  });

  it('fetches the network passphrase once and reuses it', async () => {
    const client = new FakeClient(async () =>
      success(retval(variant('Scored', xdr.ScVal.scvU32(1)))),
    );
    const o = oracle(client);
    await o.getScore(ACCOUNT);
    await o.getScore(ACCOUNT);
    expect(client.networkCalls).toBe(1);
  });

  it('throws WrongNetworkError before simulating when the RPC is on another network', async () => {
    const client = new FakeClient(
      async () => success(retval(variant('Scored', xdr.ScVal.scvU32(1)))),
      'Public Global Stellar Network ; September 2015',
    );
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toBeInstanceOf(WrongNetworkError);
    expect(client.sent).toHaveLength(0);
  });

  it('maps a missing contract instance to ContractIncompatibilityError CONTRACT_NOT_FOUND', async () => {
    const client = new FakeClient(async () =>
      simError(
        'HostError: Error(Storage, MissingValue)\n\nEvent log: "trying to get non-existing value for contract instance"',
      ),
    );
    const error = await oracle(client)
      .getScore(ACCOUNT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractIncompatibilityError);
    expect((error as ContractIncompatibilityError).code).toBe('CONTRACT_NOT_FOUND');
  });

  it('maps a missing function to ContractIncompatibilityError', async () => {
    const client = new FakeClient(async () =>
      simError(
        'HostError: Error(WasmVm, MissingValue)\n\n"trying to invoke non-existent contract function"',
      ),
    );
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toBeInstanceOf(
      ContractIncompatibilityError,
    );
  });

  it('maps other simulation failures to OracleUnavailableError', async () => {
    const client = new FakeClient(async () => simError('HostError: Error(Budget, ExceededLimit)'));
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toBeInstanceOf(OracleUnavailableError);
  });

  it('maps an archived entry (restore preamble) to OracleUnavailableError', async () => {
    const client = new FakeClient(async () => {
      const response = success(retval(variant('Scored', xdr.ScVal.scvU32(1)))) as unknown as Record<
        string,
        unknown
      >;
      response.restorePreamble = { minResourceFee: '1', transactionData: {} };
      return response as unknown as rpc.Api.SimulateTransactionResponse;
    });
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toThrow(/archived/);
  });

  it('maps network failures to OracleUnavailableError', async () => {
    const client = new FakeClient(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await oracle(client)
      .getScore(ACCOUNT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OracleUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('does not cache a failed getNetwork call', async () => {
    let fail = true;
    const client: StellarRpcClient = {
      async getNetwork() {
        if (fail) throw new Error('down');
        return { passphrase: TESTNET };
      },
      async simulateTransaction() {
        return success(retval(variant('Scored', xdr.ScVal.scvU32(3))));
      },
    };
    const o = oracle(client);
    await expect(o.getScore(ACCOUNT)).rejects.toBeInstanceOf(OracleUnavailableError);
    fail = false;
    await expect(o.getScore(ACCOUNT)).resolves.toBe(3);
  });

  it('times out with OracleTimeoutError', async () => {
    const client = new FakeClient(() => new Promise(() => {}));
    const transport = new StellarRpcTransport({
      rpcUrl: 'https://rpc.invalid',
      contractId: CONTRACT,
      client,
    });
    const o = new SorobanOracle(
      {
        environment: 'test',
        networkPassphrase: TESTNET,
        rpcEndpoints: ['https://rpc.invalid'],
        contractId: CONTRACT,
        supportedInterfaceVersionRange: { min: 1, max: 1 },
        finalityPolicy: { minConfirmations: 0, maxResultAgeMs: 1000 },
        requestBudgetMs: 20,
      },
      transport,
    );
    await expect(o.getScore(ACCOUNT)).rejects.toBeInstanceOf(OracleTimeoutError);
  });

  it('cancels with OracleCancelledError when the signal aborts', async () => {
    const client = new FakeClient(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = oracle(client).getScoreCancellable(ACCOUNT, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
  });

  it.each([
    ['not a tuple', xdr.ScVal.scvU32(5)],
    ['unknown variant', retval(variant('Maybe'))],
    ['score out of range', retval(variant('Scored', xdr.ScVal.scvU32(101)))],
    ['interface version 0', retval(variant('Scored', xdr.ScVal.scvU32(5)), 100, nowSecs(), 0)],
  ])('rejects a malformed return value: %s', async (_name, value) => {
    const client = new FakeClient(async () => success(value));
    await expect(oracle(client).getScore(ACCOUNT)).rejects.toBeInstanceOf(
      MalformedOracleResponseError,
    );
  });

  it('is a live transport, so a production SorobanOracle accepts it', () => {
    const client = new FakeClient(async () => success(retval(variant('Unscored'))));
    expect(() =>
      createSorobanOracle({
        environment: 'production',
        networkPassphrase: TESTNET,
        rpcUrl: 'https://rpc.invalid',
        contractId: CONTRACT,
        client,
      }),
    ).not.toThrow();
  });

  it('validates its own options', () => {
    expect(() => new StellarRpcTransport({ rpcUrl: 'nope', contractId: CONTRACT })).toThrow(
      RangeError,
    );
    expect(
      () => new StellarRpcTransport({ rpcUrl: 'http://localhost:8000', contractId: CONTRACT }),
    ).toThrow(/allowHttp/);
    expect(
      () => new StellarRpcTransport({ rpcUrl: 'https://rpc.invalid', contractId: ACCOUNT }),
    ).toThrow(/contractId/);
  });
});
