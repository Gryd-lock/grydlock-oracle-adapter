import { describe, expect, it, vi, beforeEach } from 'vitest';
import { rpc, nativeToScVal } from '@stellar/stellar-sdk';
import { SorobanOracle } from '../src/SorobanOracle';
import {
  OracleTimeoutError,
  OracleUnavailableError,
  InvalidDestinationError,
  ContractIncompatibilityError,
} from '../src/OracleError';

const mockSimulateTransaction = vi.fn();

// Mock stellar-sdk rpc
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual: any = await importOriginal();
  class MockServer {
    simulateTransaction = mockSimulateTransaction;
  }
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: MockServer,
      Api: {
        ...actual.rpc?.Api,
        isSimulationError: (res: any) => !!res.error,
        isSimulationSuccess: (res: any) => !res.error && !!res.result,
      }
    },
  };
});

describe('SorobanOracle', () => {
  const rpcUrl = 'https://soroban-testnet.stellar.org:443';
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const validDest = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  let oracle: SorobanOracle;
  beforeEach(() => {
    vi.clearAllMocks();
    oracle = new SorobanOracle({ rpcUrl, contractId, timeoutMs: 100 });
  });

  it('validates destination before RPC request', async () => {
    await expect(oracle.getScore('invalid-dest')).rejects.toThrow(InvalidDestinationError);
    expect(mockSimulateTransaction).not.toHaveBeenCalled();
  });

  it('returns score on successful simulation', async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: undefined,
      result: {
        retval: nativeToScVal(42, { type: 'u32' }),
      },
    });

    const result = await oracle.getScoreDetailed(validDest);
    expect(result).toMatchObject({
      score: 42,
      source: 'soroban',
      cacheStatus: 'live',
    });
    expect(result.timestamp).toBeTypeOf('number');
  });

  it('throws ContractIncompatibilityError on simulation error', async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: 'Host error',
    });

    await expect(oracle.getScoreDetailed(validDest)).rejects.toThrow(ContractIncompatibilityError);
  });

  it('throws OracleUnavailableError on network failure', async () => {
    mockSimulateTransaction.mockRejectedValue(new Error('Network offline'));

    await expect(oracle.getScoreDetailed(validDest)).rejects.toThrow(OracleUnavailableError);
  });

  it('throws OracleTimeoutError on timeout', async () => {
    mockSimulateTransaction.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 200))
    );

    await expect(oracle.getScoreDetailed(validDest)).rejects.toThrow(OracleTimeoutError);
  });

  it('throws ContractIncompatibilityError when score is out of bounds', async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: undefined,
      result: {
        retval: nativeToScVal(105, { type: 'u32' }),
      },
    });

    await expect(oracle.getScoreDetailed(validDest)).rejects.toThrow(ContractIncompatibilityError);
  });

  describe.runIf(process.env.TESTNET_CONTRACT_ID)('Integration', () => {
    it('connects to testnet and reads a score', async () => {
      const liveOracle = new SorobanOracle({
        rpcUrl: 'https://soroban-testnet.stellar.org:443',
        contractId: process.env.TESTNET_CONTRACT_ID!,
        timeoutMs: 10000,
      });

      const result = await liveOracle.getScoreDetailed(validDest);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.source).toBe('soroban');
      expect(result.cacheStatus).toBe('live');
    });
  });
});
