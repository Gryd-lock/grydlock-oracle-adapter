import { describe, expect, it } from 'vitest';
import {
  CircuitBreakerOracle,
  CoalescingOracle,
  compose,
  ContractIncompatibilityError,
  DefaultOracle,
  FallbackOracle,
  InvalidDestinationError,
  Logger,
  noopLogger,
  OracleError,
  OracleTimeoutError,
  OracleUnavailableError,
  ProvenanceOracle,
  QuorumNotMetError,
  RiskOracleAggregator,
  StubOracle,
  toBatchOracle,
  typedFallbackOracle,
  UnrecognizedDestinationError,
  validateDestination,
  withCache,
  withProvenance,
  withRateLimit,
  withTimeout,
} from '../src';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

/**
 * Runtime smoke test for the package entry point (`src/index.ts`): asserts
 * the README-documented imports actually resolve from the barrel and behave
 * (see tests/type-tests/PublicApi.type-test.ts for the compile-time half).
 */
describe('public package entry point (src/index.ts)', () => {
  it('runs the README quick-start snippet end to end', async () => {
    const logger: Logger = noopLogger;

    const oracle = new CoalescingOracle(new StubOracle(), logger);

    await expect(oracle.getScore(DESTINATION)).resolves.toBe(95);
  });

  it('exposes the documented oracle implementations', () => {
    expect(typeof StubOracle).toBe('function');
    expect(typeof CoalescingOracle).toBe('function');
    expect(typeof DefaultOracle).toBe('function');
    expect(typeof ProvenanceOracle).toBe('function');
    expect(typeof CircuitBreakerOracle).toBe('function');
    expect(typeof FallbackOracle).toBe('function');
    expect(typeof RiskOracleAggregator).toBe('function');
    expect(typeof typedFallbackOracle).toBe('function');
    expect(typeof toBatchOracle).toBe('function');
  });

  it('exposes the documented error taxonomy with stable codes', () => {
    const unavailable = new OracleUnavailableError();
    const timedOut = new OracleTimeoutError();
    const invalid = new InvalidDestinationError('GABC');
    const unrecognized = new UnrecognizedDestinationError('GABC');
    const incompatible = new ContractIncompatibilityError();
    const quorum = new QuorumNotMetError('GABC', { required: 1, succeeded: 0, total: 1 });

    for (const error of [unavailable, timedOut, invalid, unrecognized, incompatible, quorum]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(OracleError);
    }

    expect(unavailable.code).toBe('ORACLE_UNAVAILABLE');
    expect(timedOut.code).toBe('ORACLE_TIMEOUT');
    expect(invalid.code).toBe('INVALID_DESTINATION');
    expect(unrecognized.code).toBe('UNRECOGNIZED_DESTINATION');
    expect(incompatible.code).toBe('CONTRACT_INCOMPATIBILITY');
    expect(quorum.code).toBe('QUORUM_NOT_MET');
  });

  it('exposes composable middleware and a working pipeline', async () => {
    const oracle = compose(
      withCache({ ttlMs: 60_000 }),
      withProvenance({ source: 'smoke', logger: noopLogger }),
      withTimeout({ timeoutMs: 1_000 }),
      withRateLimit({ budget: 100, windowMs: 1_000, contextId: 'smoke' }),
    )(new StubOracle());

    await expect(oracle.getScore(DESTINATION)).resolves.toBe(95);
  });

  it('exposes destination validation helpers', () => {
    expect(validateDestination(DESTINATION).canonical).toBe(DESTINATION);
  });
});
