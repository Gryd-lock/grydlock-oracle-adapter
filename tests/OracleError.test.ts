import { describe, expect, it } from 'vitest';
import {
  OracleError,
  OracleTimeoutError,
  OracleUnavailableError,
  InvalidDestinationError,
  UnrecognizedDestinationError,
  ContractIncompatibilityError,
} from '../src/OracleError';

describe('OracleError', () => {
  it('preserves stable error codes', () => {
    expect(new OracleTimeoutError().code).toBe('ORACLE_TIMEOUT');
    expect(new OracleUnavailableError().code).toBe('ORACLE_UNAVAILABLE');
    expect(new InvalidDestinationError('GABC').code).toBe('INVALID_DESTINATION');
    expect(new UnrecognizedDestinationError('GABC').code).toBe('UNRECOGNIZED_DESTINATION');
    expect(new ContractIncompatibilityError().code).toBe('CONTRACT_INCOMPATIBILITY');
  });

  it('supports instanceof checks', () => {
    const error = new OracleTimeoutError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(OracleError);
    expect(error).toBeInstanceOf(OracleTimeoutError);
  });

  it('stores structured destination context', () => {
    const error = new InvalidDestinationError('GTEST123');

    expect(error.context.destination).toBe('GTEST123');
  });

  it('preserves causes', () => {
    const cause = new Error('network');

    const error = new OracleUnavailableError(undefined, {
      cause,
    });

    expect(error.cause).toBe(cause);
  });

  it('uses stable class names', () => {
    expect(new OracleTimeoutError().name).toBe('OracleTimeoutError');
  });
});