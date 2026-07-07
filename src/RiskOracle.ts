/**
 * Read-only source of risk scores for Stellar destinations.
 *
 * Implementations must resolve to an integer in the inclusive range 0-100,
 * where higher values indicate higher suspected risk.
 */
export interface RiskOracle {
  /**
   * @param destination A Stellar address or asset identifier.
   * @returns A risk score between 0 and 100 (inclusive).
   */
  getScore(destination: string): Promise<number>;
}
