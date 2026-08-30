import { describe, expect, it } from 'vitest';
import {
  OracleError,
  OracleTimeoutError,
  OracleUnavailableError,
  InvalidDestinationError,
  UnrecognizedDestinationError,
  ContractIncompatibilityError,
  UnsupportedInterfaceVersionError,
  WrongNetworkError,
  WrongContractError,
  MalformedOracleResponseError,
  InsufficientFinalityError,
  ScoreNotYetComputedError,
} from '../src/OracleError';

describe('OracleError', () => {
  it('preserves stable error codes', () => {
    expect(new OracleTimeoutError().code).toBe('ORACLE_TIMEOUT');
    expect(new OracleUnavailableError().code).toBe('ORACLE_UNAVAILABLE');
    expect(new InvalidDestinationError('GABC').code).toBe('INVALID_DESTINATION');
    expect(new UnrecognizedDestinationError('GABC').code).toBe('UNRECOGNIZED_DESTINATION');
    expect(new ContractIncompatibilityError().code).toBe('CONTRACT_INCOMPATIBILITY');
  });

  describe('SorobanOracle protocol errors', () => {
    it('preserves stable error codes', () => {
      expect(
        new UnsupportedInterfaceVersionError('bad', {
          reportedVersion: 2,
          supportedRange: { min: 1, max: 1 },
        }).code,
      ).toBe('UNSUPPORTED_INTERFACE_VERSION');
      expect(
        new WrongNetworkError(undefined, {
          expectedNetworkPassphrase: 'a',
          actualNetworkPassphrase: 'b',
        }).code,
      ).toBe('WRONG_NETWORK');
      expect(
        new WrongContractError(undefined, {
          expectedContractId: 'a',
          actualContractId: 'b',
        }).code,
      ).toBe('WRONG_CONTRACT');
      expect(new MalformedOracleResponseError().code).toBe('MALFORMED_ORACLE_RESPONSE');
      expect(
        new InsufficientFinalityError(undefined, {
          resultLedgerSequence: 1,
          observedLedgerSequence: 1,
          requiredConfirmations: 2,
          observedConfirmations: 0,
        }).code,
      ).toBe('INSUFFICIENT_FINALITY');
      expect(new ScoreNotYetComputedError('GABC').code).toBe('SCORE_NOT_YET_COMPUTED');
    });

    it('UnsupportedInterfaceVersionError is a ContractIncompatibilityError specialization', () => {
      const error = new UnsupportedInterfaceVersionError('bad', {
        reportedVersion: 2,
        supportedRange: { min: 1, max: 1 },
      });

      expect(error).toBeInstanceOf(ContractIncompatibilityError);
      expect(error).toBeInstanceOf(OracleError);
      // A plain ContractIncompatibilityError keeps its own, more general code.
      expect(new ContractIncompatibilityError().code).toBe('CONTRACT_INCOMPATIBILITY');
    });

    it('every new error extends OracleError and supports instanceof', () => {
      const errors = [
        new UnsupportedInterfaceVersionError('bad', {
          reportedVersion: 2,
          supportedRange: { min: 1, max: 1 },
        }),
        new WrongNetworkError(undefined, {
          expectedNetworkPassphrase: 'a',
          actualNetworkPassphrase: 'b',
        }),
        new WrongContractError(undefined, { expectedContractId: 'a', actualContractId: 'b' }),
        new MalformedOracleResponseError(),
        new InsufficientFinalityError(undefined, {
          resultLedgerSequence: 1,
          observedLedgerSequence: 1,
          requiredConfirmations: 2,
          observedConfirmations: 0,
        }),
        new ScoreNotYetComputedError('GABC'),
      ];

      for (const error of errors) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(OracleError);
      }
    });
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
