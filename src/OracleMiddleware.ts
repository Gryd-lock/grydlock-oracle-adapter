import { RiskOracle } from './RiskOracle';

/**
 * A cross-cutting concern for RiskOracle calls (caching, timeout, retry,
 * circuit breaking, logging, ...), expressed as a wrapper: it receives the
 * next oracle in the chain and returns an oracle that adds one behavior
 * around it.
 *
 * Every concern implements this one shape, so any combination composes with
 * {@link compose} instead of each wrapper inventing its own "wrap and
 * delegate" boilerplate.
 */
export type OracleMiddleware = (next: RiskOracle) => RiskOracle;

/**
 * Composes middlewares around an oracle. The FIRST middleware listed is the
 * OUTERMOST layer — it sees the caller's getScore first and its result last,
 * exactly like reading the list top-to-bottom as layers around the oracle:
 *
 * ```ts
 * const oracle = compose(
 *   withCache({ ttlMs: 30_000 }), // outermost: cache hit skips everything below
 *   withTimeout({ timeoutMs: 1_500 }), // innermost: bounds the raw call
 * )(new StubOracle());
 * ```
 *
 * `compose()` with no arguments returns the oracle unchanged, and the result
 * of `compose` is itself an OracleMiddleware, so pipelines nest:
 * `compose(a, compose(b, c))` === `compose(a, b, c)`.
 *
 * The recommended production order for the concerns planned in #6-#10, #27
 * and #41 is documented in the README ("Composing cross-cutting concerns").
 */
export function compose(...middlewares: OracleMiddleware[]): OracleMiddleware {
  return (oracle: RiskOracle) =>
    middlewares.reduceRight((next, middleware) => middleware(next), oracle);
}
