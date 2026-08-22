import { RiskOracle } from '../RiskOracle';
import { OracleMiddleware } from '../OracleMiddleware';
import { OracleTimeoutError } from '../OracleError';

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
 * The RiskOracle interface does not yet accept an AbortSignal, so the
 * losing underlying call cannot be truly cancelled; it is detached and its
 * eventual failure silenced. When #7 lands signal support on the interface,
 * this middleware is where the AbortController belongs.
 */
export function withTimeout(options: TimeoutOptions): OracleMiddleware {
  const { timeoutMs } = options;
  return (next: RiskOracle): RiskOracle => ({
    async getScore(destination: string): Promise<number> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inner = next.getScore(destination);
      try {
        return await Promise.race([
          inner,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new OracleTimeoutError(
                    `getScore("${destination}") timed out after ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } catch (err) {
        if (err instanceof OracleTimeoutError) {
          // The abandoned call may still settle later; a late rejection must
          // not surface as an unhandled promise rejection.
          inner.catch(() => {});
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
