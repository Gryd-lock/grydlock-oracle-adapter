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

/**
 * Identifies which underlying oracle/tier produced a score, e.g. "StubOracle",
 * "soroban", or a fallback-chain tier name.
 */
export type OracleSource = string;

/**
 * How a returned score relates to the underlying data source:
 *
 * - `live`        — read directly from the source on this call
 * - `cache-fresh` — served from cache within its fresh window
 * - `cache-stale` — served from cache past its fresh window (stale-while-revalidate)
 * - `default`     — a hardcoded fallback value; no source answered
 * - `unknown`     — the implementation cannot tell (e.g. a plain RiskOracle
 *                   wrapped by a decorator that has no visibility inside it)
 */
export type CacheStatus = 'live' | 'cache-fresh' | 'cache-stale' | 'default' | 'unknown';

/**
 * A score plus the metadata needed to judge how much to trust it.
 */
export interface ScoredResult {
  /** Risk score between 0 and 100 (inclusive). */
  score: number;
  /** Epoch milliseconds at which the score was produced. */
  timestamp: number;
  /** Which oracle/tier produced the score. */
  source: OracleSource;
  /** Whether the score is live, cached, stale, or a fallback default. */
  cacheStatus: CacheStatus;
  /** Optional 0-1 confidence reported by the source. */
  confidence?: number;
}

/**
 * A RiskOracle that can also report score metadata. `getScoreDetailed` must
 * resolve the same score `getScore` would for the same destination; existing
 * consumers of `getScore` are unaffected.
 */
export interface DetailedRiskOracle extends RiskOracle {
  getScoreDetailed(destination: string): Promise<ScoredResult>;
}
