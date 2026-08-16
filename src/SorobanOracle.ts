import { Contract, nativeToScVal, rpc, scValToNative, TransactionBuilder, Networks, Account } from '@stellar/stellar-sdk';
import { DetailedRiskOracle, RiskOracle, ScoredResult } from './RiskOracle';
import { validateDestination } from './DestinationValidator';
import { ContractIncompatibilityError, OracleTimeoutError, OracleUnavailableError, InvalidDestinationError } from './OracleError';

export interface SorobanOracleOptions {
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Address of the Soroban risk oracle contract */
  contractId: string;
  /** Network passphrase (e.g. Testnet or Public) */
  networkPassphrase?: string;
  /** Optional timeout for the RPC request in milliseconds */
  timeoutMs?: number;
}

export class SorobanOracle implements RiskOracle, DetailedRiskOracle {
  private server: rpc.Server;
  private contract: Contract;
  private networkPassphrase: string;
  private timeoutMs: number;

  constructor(options: SorobanOracleOptions) {
    this.server = new rpc.Server(options.rpcUrl, {
      allowHttp: options.rpcUrl.startsWith('http://'),
    });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase || Networks.TESTNET;
    this.timeoutMs = options.timeoutMs || 5000;
  }

  async getScore(destination: string): Promise<number> {
    const result = await this.getScoreDetailed(destination);
    return result.score;
  }

  async getScoreDetailed(destination: string): Promise<ScoredResult> {
    // 1. Validate destination
    const valid = validateDestination(destination);

    // 2. Prepare contract call
    // For reads, we can simulate a transaction from a dummy account
    const source = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
    
    // Convert the canonical destination to an scval
    const destVal = nativeToScVal(valid.canonical, { type: 'string' });

    let simResult;
    try {
      const tx = new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call('get_score', destVal))
        .setTimeout(0) // transaction valid bounds, not RPC timeout
        .build();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      
      try {
        const req = this.server.simulateTransaction(tx);
        simResult = await Promise.race([
          req,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), this.timeoutMs)
          ),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      if (err.message === 'timeout') {
        throw new OracleTimeoutError(destination, { cause: err });
      }
      throw new OracleUnavailableError(err.message, { cause: err });
    }

    if (rpc.Api.isSimulationError(simResult)) {
      throw new ContractIncompatibilityError(typeof simResult.error === 'string' ? simResult.error : 'Simulation error');
    }
    
    if (!rpc.Api.isSimulationSuccess(simResult)) {
        throw new OracleUnavailableError('Simulation failed without detailed error');
    }

    // 3. Extract and validate result
    if (!simResult.result?.retval) {
      throw new ContractIncompatibilityError('No return value from contract');
    }

    let score: number;
    try {
      score = scValToNative(simResult.result.retval);
    } catch (err) {
      throw new ContractIncompatibilityError('Unrecognized response format', { cause: err });
    }

    if (typeof score !== 'number' || score < 0 || score > 100 || !Number.isInteger(score)) {
      throw new ContractIncompatibilityError(`Score ${score} is out of bounds (0-100) or not an integer`);
    }

    return {
      score,
      timestamp: Date.now(),
      source: 'soroban',
      cacheStatus: 'live',
    };
  }
}
