import { RiskOracle } from './RiskOracle';
import { OracleCancelledError } from './OracleError';

/**
 * A `RiskOracle` that can abandon an in-flight request when told to.
 *
 * This is an additive, optional extension of `RiskOracle` — not a
 * replacement — expressed as a distinctly-named second method
 * (`getScoreCancellable`) rather than an extra parameter on `getScore`
 * itself, mirroring how `DetailedRiskOracle` adds `getScoreDetailed` rather
 * than changing `getScore`'s signature. Existing `RiskOracle`
 * implementations remain completely unaffected: they don't have this
 * method, `isCancellable` reports `false` for them, and every wrapper in
 * this package falls back to plain `getScore` (today's reject-only-the-
 * caller behavior) when wrapping one.
 *
 * ## Cancellation contract
 *
 * An implementation of `getScoreCancellable` must, once `signal` fires:
 *
 * - Stop consuming the resource the call was using (abort the underlying
 *   HTTP/RPC request, clear pending timers, etc.) — not merely stop the
 *   caller from waiting on it.
 * - Reject with `OracleCancelledError` (see `OracleError.ts`), not with
 *   whatever error/value the abandoned request would otherwise have
 *   produced, so a cancellation is distinguishable from a real failure.
 *
 * `getScoreCancellable` must resolve to the same score `getScore` would for
 * the same destination when the signal never fires.
 */
export interface CancellableRiskOracle extends RiskOracle {
  /**
   * @param destination A Stellar address or asset identifier.
   * @param signal Aborting this cancels the request; see the interface doc
   * for the resulting contract.
   * @returns The same score `getScore` would resolve, unless cancelled.
   */
  getScoreCancellable(destination: string, signal: AbortSignal): Promise<number>;
}

/** Type guard: does `oracle` support cancellation via `getScoreCancellable`? */
export function isCancellable(oracle: RiskOracle): oracle is CancellableRiskOracle {
  return typeof (oracle as Partial<CancellableRiskOracle>).getScoreCancellable === 'function';
}

/**
 * Races `promise` against `signal`'s own abort event, without affecting
 * `promise` itself. Used across this package's cancellation-aware wrappers
 * (`CircuitBreakerOracle`, `FallbackOracle`) wherever `promise` may be a
 * resource shared with other callers (e.g. `CircuitBreakerOracle`'s
 * HALF_OPEN probe) that this one caller alone must not be able to tear
 * down, or wherever `promise` simply isn't cancellable itself (a plain,
 * non-`CancellableRiskOracle` inner) but the caller should still be able to
 * bail out immediately rather than wait for it.
 */
export function raceWithCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  destination: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new OracleCancelledError('The oracle request was cancelled.', { destination }));
    };
    signal.addEventListener('abort', onAbort);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
