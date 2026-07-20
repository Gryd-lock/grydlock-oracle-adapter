import { RiskOracle } from './RiskOracle';

/**
 * Observer for fallback attempts.
 *
 * Future logger implementations can implement this interface to
 * record degraded oracle behavior without coupling FallbackOracle
 * to a logging framework.
 */
export interface FallbackObserver {
  /**
   * Called whenever an oracle in the fallback chain fails.
   */
  onFallback(error: unknown, oracle: RiskOracle): void;
}