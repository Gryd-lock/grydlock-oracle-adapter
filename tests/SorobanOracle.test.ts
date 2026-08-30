import { describe, expect, it } from 'vitest';
import { SorobanOracle, SorobanOracleConfig } from '../src/SorobanOracle';
import {
  OracleCancelledError,
  OracleUnavailableError,
  InvalidDestinationError,
  UnrecognizedDestinationError,
  ScoreNotYetComputedError,
  MalformedOracleResponseError,
  UnsupportedInterfaceVersionError,
  ContractIncompatibilityError,
  WrongNetworkError,
  WrongContractError,
  InsufficientFinalityError,
} from '../src/OracleError';
import {
  FakeSorobanRpcTransport,
  makeRawScoredResponse,
  makeRawAbsenceResponse,
} from './support/FakeSorobanRpcTransport';

const ACCOUNT = 'GCRRYBV5IY7DSI54DKW33ZELC2LWYCAHC43TXAM2A2HTFN5GWOFWXPC2';
const OTHER_ACCOUNT = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

function baseConfig(overrides: Partial<SorobanOracleConfig> = {}): SorobanOracleConfig {
  return {
    environment: 'test',
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcEndpoints: ['https://soroban-testnet.stellar.org'],
    contractId: CONTRACT_ID,
    supportedInterfaceVersionRange: { min: 1, max: 1 },
    finalityPolicy: { minConfirmations: 2, maxResultAgeMs: 60_000 },
    requestBudgetMs: 5_000,
    ...overrides,
  };
}

describe('SorobanOracle construction', () => {
  it('accepts a well-formed config and fixture transport outside production', () => {
    expect(() => new SorobanOracle(baseConfig(), new FakeSorobanRpcTransport())).not.toThrow();
  });

  it('rejects an unrecognized environment', () => {
    expect(
      () =>
        new SorobanOracle(
          baseConfig({ environment: 'prod' as never }),
          new FakeSorobanRpcTransport(),
        ),
    ).toThrow(RangeError);
  });

  it('rejects an empty networkPassphrase', () => {
    expect(
      () => new SorobanOracle(baseConfig({ networkPassphrase: '' }), new FakeSorobanRpcTransport()),
    ).toThrow(RangeError);
  });

  it('rejects an empty rpcEndpoints list', () => {
    expect(
      () => new SorobanOracle(baseConfig({ rpcEndpoints: [] }), new FakeSorobanRpcTransport()),
    ).toThrow(RangeError);
  });

  it('rejects a malformed rpcEndpoints URL', () => {
    expect(
      () =>
        new SorobanOracle(
          baseConfig({ rpcEndpoints: ['not-a-url'] }),
          new FakeSorobanRpcTransport(),
        ),
    ).toThrow(RangeError);
  });

  it('rejects a non-ftp rpcEndpoints scheme', () => {
    expect(
      () =>
        new SorobanOracle(
          baseConfig({ rpcEndpoints: ['ftp://example.com'] }),
          new FakeSorobanRpcTransport(),
        ),
    ).toThrow(RangeError);
  });

  it('rejects a contractId that is not a valid Soroban contract address', () => {
    expect(
      () => new SorobanOracle(baseConfig({ contractId: ACCOUNT }), new FakeSorobanRpcTransport()),
    ).toThrow(RangeError);
  });

  it('rejects an invalid supportedInterfaceVersionRange', () => {
    expect(
      () =>
        new SorobanOracle(
          baseConfig({ supportedInterfaceVersionRange: { min: 3, max: 1 } }),
          new FakeSorobanRpcTransport(),
        ),
    ).toThrow(RangeError);
  });

  it('rejects a negative finalityPolicy.minConfirmations', () => {
    expect(
      () =>
        new SorobanOracle(
          baseConfig({ finalityPolicy: { minConfirmations: -1, maxResultAgeMs: 1000 } }),
          new FakeSorobanRpcTransport(),
        ),
    ).toThrow(RangeError);
  });

  it('rejects a non-positive finalityPolicy.maxResultAgeMs', () => {
    expect(
      () =>
        new SorobanOracle(
          baseConfig({ finalityPolicy: { minConfirmations: 0, maxResultAgeMs: 0 } }),
          new FakeSorobanRpcTransport(),
        ),
    ).toThrow(RangeError);
  });

  it('rejects a non-positive requestBudgetMs', () => {
    expect(
      () => new SorobanOracle(baseConfig({ requestBudgetMs: 0 }), new FakeSorobanRpcTransport()),
    ).toThrow(RangeError);
  });

  it('rejects a transport missing invokeGetScore', () => {
    expect(() => new SorobanOracle(baseConfig(), {} as never)).toThrow(TypeError);
  });

  it('refuses a fixture transport when environment is "production"', () => {
    expect(
      () =>
        new SorobanOracle(baseConfig({ environment: 'production' }), new FakeSorobanRpcTransport()),
    ).toThrow(/production/i);
  });

  it('accepts a transport declaring transportKind "live" in production', () => {
    const liveTransport = new FakeSorobanRpcTransport('live');
    expect(
      () => new SorobanOracle(baseConfig({ environment: 'production' }), liveTransport),
    ).not.toThrow();
  });
});

describe('SorobanOracle.getScoreDetailed', () => {
  it('returns a live score with network/contract/version/ledger-checkpoint metadata for a known destination', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(ACCOUNT, makeRawScoredResponse(42, { latestSeenSequence: 1_000_010 }));
    const oracle = new SorobanOracle(baseConfig(), transport);

    const result = await oracle.getScoreDetailed(ACCOUNT);

    expect(result.score).toBe(42);
    expect(result.cacheStatus).toBe('live');
    expect(result.source).toBe('SorobanOracle');
    expect(result.networkPassphrase).toBe(NETWORK_PASSPHRASE);
    expect(result.contractId).toBe(CONTRACT_ID);
    expect(result.interfaceVersion).toBe(1);
    expect(result.ledgerSequence).toBe(1_000_000);
    expect(result.observedConfirmations).toBe(10);
    expect(typeof result.timestamp).toBe('number');
  });

  it('getScore resolves the same score as getScoreDetailed', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(ACCOUNT, makeRawScoredResponse(17));
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScore(ACCOUNT)).resolves.toBe(17);
  });

  it('throws InvalidDestinationError for a malformed destination before ever calling the transport', async () => {
    const transport = new FakeSorobanRpcTransport();
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed('not-a-stellar-address')).rejects.toBeInstanceOf(
      InvalidDestinationError,
    );
    expect(transport.invocations).toHaveLength(0);
  });

  it('throws UnrecognizedDestinationError — never a numeric score — when the oracle deliberately has no score', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(OTHER_ACCOUNT, makeRawAbsenceResponse('unscored'));
    const oracle = new SorobanOracle(baseConfig(), transport);

    const rejection = expect(oracle.getScoreDetailed(OTHER_ACCOUNT)).rejects;
    await rejection.toBeInstanceOf(UnrecognizedDestinationError);
    await rejection.not.toBeInstanceOf(TypeError);
  });

  it('throws ScoreNotYetComputedError — distinct from UnrecognizedDestinationError — when computation is pending', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(OTHER_ACCOUNT, makeRawAbsenceResponse('pending'));
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed(OTHER_ACCOUNT)).rejects.toBeInstanceOf(
      ScoreNotYetComputedError,
    );
  });

  it('wraps a transport failure as OracleUnavailableError (provider failure, distinct from both absence variants)', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setError(ACCOUNT, new Error('connection refused'));
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed(ACCOUNT)).rejects.toBeInstanceOf(OracleUnavailableError);
  });

  it('throws MalformedOracleResponseError for a response that fails schema validation', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(ACCOUNT, { totally: 'not a valid response' });
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed(ACCOUNT)).rejects.toBeInstanceOf(
      MalformedOracleResponseError,
    );
  });

  it('throws MalformedOracleResponseError for a score outside 0-100', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(ACCOUNT, makeRawScoredResponse(101));
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed(ACCOUNT)).rejects.toBeInstanceOf(
      MalformedOracleResponseError,
    );
  });

  it('fails closed with UnsupportedInterfaceVersionError for an out-of-range interface version', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(ACCOUNT, makeRawScoredResponse(10, { interfaceVersion: 99 }));
    const oracle = new SorobanOracle(baseConfig(), transport);

    const rejection = expect(oracle.getScoreDetailed(ACCOUNT)).rejects;
    await rejection.toBeInstanceOf(UnsupportedInterfaceVersionError);
    // A version mismatch is a specialization of contract incompatibility.
    await rejection.toBeInstanceOf(ContractIncompatibilityError);
  });

  it('rejects a wrong-network response before any finality check runs', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(
      ACCOUNT,
      makeRawScoredResponse(10, {
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        // Also insufficiently final — proves network is checked first.
        latestSeenSequence: 1_000_000,
      }),
    );
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed(ACCOUNT)).rejects.toBeInstanceOf(WrongNetworkError);
  });

  it('rejects a wrong-contract response before any finality check runs', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(
      ACCOUNT,
      makeRawScoredResponse(10, {
        contractId: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR4B4QMSJ7YOBLL',
        latestSeenSequence: 1_000_000,
      }),
    );
    const oracle = new SorobanOracle(baseConfig(), transport);

    await expect(oracle.getScoreDetailed(ACCOUNT)).rejects.toBeInstanceOf(WrongContractError);
  });

  it('fails closed with InsufficientFinalityError when confirmations are below the policy minimum', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(
      ACCOUNT,
      makeRawScoredResponse(10, { ledgerSequence: 1_000_000, latestSeenSequence: 1_000_001 }),
    );
    const oracle = new SorobanOracle(
      baseConfig({ finalityPolicy: { minConfirmations: 5, maxResultAgeMs: 60_000 } }),
      transport,
    );

    await expect(oracle.getScoreDetailed(ACCOUNT)).rejects.toBeInstanceOf(
      InsufficientFinalityError,
    );
  });

  it('labels a fully-confirmed but old result "cache-stale" rather than "live" — not silently treated as current', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(
      ACCOUNT,
      makeRawScoredResponse(10, {
        latestSeenSequence: 1_000_010,
        ledgerCloseTimeUnixMs: Date.now() - 10 * 60 * 1000, // 10 minutes old
      }),
    );
    const oracle = new SorobanOracle(
      baseConfig({ finalityPolicy: { minConfirmations: 1, maxResultAgeMs: 60_000 } }),
      transport,
    );

    const result = await oracle.getScoreDetailed(ACCOUNT);
    expect(result.score).toBe(10);
    expect(result.cacheStatus).toBe('cache-stale');
    expect(result.cacheStatus).not.toBe('live');
  });
});

describe('SorobanOracle cancellation', () => {
  it('rejects with OracleCancelledError and releases the transport when the signal fires mid-flight', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setDelay(50);
    transport.setResponse(ACCOUNT, makeRawScoredResponse(10));
    const oracle = new SorobanOracle(baseConfig(), transport);

    const controller = new AbortController();
    const pending = oracle.getScoreCancellable(ACCOUNT, controller.signal);
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
    // Give the transport's own abort handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.abortedInvocationCount).toBe(1);
  });

  it('rejects immediately with OracleCancelledError for an already-aborted signal', async () => {
    const transport = new FakeSorobanRpcTransport();
    const oracle = new SorobanOracle(baseConfig(), transport);
    const controller = new AbortController();
    controller.abort();

    await expect(oracle.getScoreCancellable(ACCOUNT, controller.signal)).rejects.toBeInstanceOf(
      OracleCancelledError,
    );
    expect(transport.invocations).toHaveLength(0);
  });

  it('getScoreDetailed honors options.signal the same way', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setDelay(50);
    transport.setResponse(ACCOUNT, makeRawScoredResponse(10));
    const oracle = new SorobanOracle(baseConfig(), transport);

    const controller = new AbortController();
    const pending = oracle.getScoreDetailed(ACCOUNT, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
  });

  it('resolves normally when the signal never fires', async () => {
    const transport = new FakeSorobanRpcTransport();
    transport.setResponse(ACCOUNT, makeRawScoredResponse(55));
    const oracle = new SorobanOracle(baseConfig(), transport);
    const controller = new AbortController();

    await expect(oracle.getScoreCancellable(ACCOUNT, controller.signal)).resolves.toBe(55);
  });
});
