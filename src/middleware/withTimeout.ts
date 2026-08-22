import { RiskOracle } from '../RiskOracle';
import { OracleMiddleware } from '../OracleMiddleware';
import { OracleTimeoutError, OracleCancelledError } from '../OracleError';
import { CancellableRiskOracle, isCancellable } from '../CancellableRiskOracle';

export { OracleTimeoutError };

/** Construction options for {@link withTimeout}. */
export interface TimeoutOptions {
  /** Maximum time a single getScore call may take, in milliseconds. */
  timeoutMs: number;
}

/**
 * Timeout middleware (issue #7), built on the shared middleware abstraction
 * (#46). Rejects with {@link OracleTimeoutError} if the next oracle does not
 * settle within the budget.
 *
 * The timeout failure reuses the shared error taxonomy in `OracleError.ts`
 * (rather than a private duplicate) so consumers can catch a single
 * `OracleTimeoutError` type — `instanceof OracleError` holds and the stable
 * `ORACLE_TIMEOUT` code is available — while the thrown message keeps the
 * destination and budget detail this middleware always carried. This module
 * re-exports the class so existing deep imports of
 * `./middleware/withTimeout` continue to resolve.
 *
 * Recommended position: innermost, directly around the raw oracle, so the
 * budget bounds exactly one underlying attempt — with retry (#10) outside,
 * each attempt gets its own budget instead of all attempts sharing one.
 *
 * When `next` implements `CancellableRiskOracle` (issue #98), a timeout
 * both rejects the caller *and* aborts the underlying request via
 * `AbortController`, so it actually stops consuming resources instead of
 * merely being abandoned. When `next` does not support cancellation, the
 * losing call cannot be truly cancelled; it is detached and its eventual
 * settlement silenced, exactly as before #98.
 *
 * The returned oracle also implements `CancellableRiskOracle` itself, via
 * `getScoreCancellable` (issue #98): a caller can cancel from *outside*,
 * not just via this middleware's own timeout, and — critically — an outer
 * cancellable-aware wrapper (`CoalescingOracle`, `CircuitBreakerOracle`,
 * `FallbackOracle`) composing `withTimeout` as one of its tiers can
 * propagate cancellation *through* it into `next`, since `isCancellable()`
 * now reports `true` for `withTimeout`'s own output. Without this, a chain
 * like `fallback(withTimeout(cancellableInner))` would never actually abort
 * `cancellableInner` on outer cancellation — `withTimeout`'s wrapper would
 * look like a plain, non-cancellable oracle to everything wrapping it.
 */
export function withTimeout(options: TimeoutOptions): OracleMiddleware {
  const { timeoutMs } = options;
  return (next: RiskOracle): RiskOracle & CancellableRiskOracle => ({
    async getScore(destination: string): Promise<number> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inner = isCancellable(next)
        ? next.getScoreCancellable(destination, controller.signal)
        : next.getScore(destination);
      try {
        return await Promise.race([
          inner,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Reject the outer race *before* aborting: if `next` is
              // cancellable, abort() synchronously rejects `inner` too, and
              // Promise.race adopts whichever underlying reject() was
              // called first — reversing this order would let a
              // cancellable inner's own OracleCancelledError win the race
              // instead of the timeout this call actually reports.
              reject(
                new OracleTimeoutError(`getScore("${destination}") timed out after ${timeoutMs}ms`),
              );
              controller.abort();
            }, timeoutMs);
          }),
        ]);
      } catch (err) {
        if (err instanceof OracleTimeoutError) {
          // The abandoned call may still settle later (immediately, if
          // `next` honored the abort above; otherwise whenever it would
          // have anyway) — a late rejection must not surface as an
          // unhandled promise rejection either way.
          inner.catch(() => {});
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
      if (signal.aborted) {
        return Promise.reject(new OracleCancelledError('The oracle request was cancelled.', { destination }));
      }

      const controller = new AbortController();
      const inner = isCancellable(next)
        ? next.getScoreCancellable(destination, controller.signal)
        : next.getScore(destination);

      const result = new Promise<number>((resolve, reject) => {
        let settled = false;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onExternalAbort);
          fn();
        };

        // Both handlers below settle this promise (via the synchronous
        // `finish` call) *before* calling abort() — defensive ordering,
        // matching getScore's own timeout handler: `finish`'s `settled`
        // guard already wins this race on its own (it runs synchronously,
        // while a cancellable inner's abort-triggered rejection only
        // reaches `finish` via the async `inner.then(...)` below), but
        // settling first removes any reliance on that ordering nuance.
        const onExternalAbort = (): void => {
          finish(() =>
            reject(new OracleCancelledError('The oracle request was cancelled.', { destination })),
          );
          controller.abort();
        };
        signal.addEventListener('abort', onExternalAbort, { once: true });

        const timer = setTimeout(() => {
          finish(() =>
            reject(new OracleTimeoutError(`getScore("${destination}") timed out after ${timeoutMs}ms`)),
          );
          controller.abort();
        }, timeoutMs);

        inner.then(
          (value) => finish(() => resolve(value)),
          (err: unknown) => finish(() => reject(err)),
        );
      });

      // Same unhandled-rejection guard as getScore above: an abandoned
      // `inner` (cancelled or timed out) may still settle later.
      return result.catch((err: unknown) => {
        if (err instanceof OracleTimeoutError || err instanceof OracleCancelledError) {
          inner.catch(() => {});
        }
        throw err;
      });
    },
  });
}
