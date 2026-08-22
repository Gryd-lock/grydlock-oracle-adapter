import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

/**
 * The read-only `get_score` surface of the risk-oracle Soroban contract, as
 * seen from this adapter. A `number | undefined` return mirrors a Soroban
 * contract that reverts for destinations it does not recognize.
 */
export interface RiskOracleFixtureContract {
  /**
   * @param destination The canonical destination passed to `get_score`.
   * @returns The fixture score (0-100), or `undefined` to simulate a contract
   * revert (unknown destination).
   */
  getScore(destination: string): number | undefined;
}

/**
 * A representative risk-oracle contract fixture backed by the vendored
 * `grydlock-testkit` scores. The real contract is expected to mirror this
 * shape: `get_score(string) -> u32`.
 */
export function createRiskOracleFixture(
  scores: Readonly<Record<string, number>>,
): RiskOracleFixtureContract {
  return {
    getScore(destination) {
      return scores[destination];
    },
  };
}

/**
 * Pulls the invoked function name and its native arguments out of a base-64
 * transaction envelope, mirroring what a Soroban RPC node does before
 * executing a simulated `InvokeHostFunctionOp`.
 */
export function extractInvocation(txXdr: string): { functionName: string; args: unknown[] } {
  const envelope = xdr.TransactionEnvelope.fromXDR(txXdr, 'base64');
  const operation = envelope.value().tx().operations()[0];
  const hostFunction = operation.body().value().hostFunction();

  if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new Error(`Expected an invoke-contract host function, got ${hostFunction.switch().name}`);
  }

  const invocation = hostFunction.value();
  return {
    functionName: invocation.functionName().toString(),
    args: invocation.args().map((scVal) => scValToNative(scVal)),
  };
}

/**
 * Encodes the returned value of a simulated invocation as base-64 XDR, the
 * form Soroban RPC places in `result.results[0].xdr`.
 */
export function encodeReturnValue(score: number): string {
  return nativeToScVal(score, { type: 'u32' }).toXDR('base64');
}
