import { RiskOracle } from './RiskOracle';

/**
 * A cross-cutting concern for RiskOracle calls (caching, timeout, retry,
 * circuit breaking, logging, ...), expressed as a wrapper: it receives the
 * next oracle in the chain and returns an oracle that adds one behavior
 * around it.
 *
 * `TIn` is the minimum shape this middleware requires of `next` (defaults to
 * the base `RiskOracle`, i.e. "works regardless of whether `next` is
 * detailed"). `TOut` is what this middleware guarantees about its own
 * result (defaults to the base `RiskOracle`, i.e. "makes no promise about
 * `getScoreDetailed`"). A middleware that only ever hands back the plain
 * shape — even when `next` was a `DetailedRiskOracle` — is
 * `OracleMiddleware<RiskOracle, RiskOracle>` (the default, and what plain
 * `OracleMiddleware` means with no type arguments); one that always adds
 * `getScoreDetailed` regardless of `next` is
 * `OracleMiddleware<RiskOracle, DetailedRiskOracle>`; one that requires an
 * already-detailed `next` and forwards that guarantee is
 * `OracleMiddleware<DetailedRiskOracle, DetailedRiskOracle>`.
 *
 * Every concern implements this one shape, so any combination composes with
 * {@link compose} instead of each wrapper inventing its own "wrap and
 * delegate" boilerplate — and {@link compose}'s result type reflects
 * exactly which of the three cases above the composed chain ends up in.
 */
export type OracleMiddleware<
  TIn extends RiskOracle = RiskOracle,
  TOut extends RiskOracle = RiskOracle,
> = (next: TIn) => TOut;

/**
 * The type of oracle a middleware chain's OUTERMOST layer ultimately needs
 * handed to it at the base — i.e. the required input type of the LAST
 * (innermost, right-most) middleware in the list, since that is the one
 * `compose` applies directly to the base oracle.
 */
type InnermostIn<Ms extends readonly OracleMiddleware[]> = Ms extends readonly [
  infer Only extends OracleMiddleware,
]
  ? Only extends OracleMiddleware<infer TIn extends RiskOracle, RiskOracle>
    ? TIn
    : never
  : Ms extends readonly [OracleMiddleware, ...infer Rest extends readonly OracleMiddleware[]]
    ? InnermostIn<Rest>
    : RiskOracle;

/**
 * Threads a middleware list right-to-left — innermost first, matching
 * `compose`'s actual `reduceRight` evaluation order — to compute the type
 * the OUTERMOST (first-listed) middleware resolves to. At each step, what
 * the layer to the right produces must satisfy what the layer to the left
 * declares it needs as `next`; this is exactly how the array's actual
 * element types (not a fixed 2- or 3-argument special case) determine
 * whether the final result is `DetailedRiskOracle` or only `RiskOracle`.
 */
type ChainOut<Ms extends readonly OracleMiddleware[]> = Ms extends readonly [
  infer Only extends OracleMiddleware,
]
  ? Only extends OracleMiddleware<never, infer TOut extends RiskOracle>
    ? TOut
    : never
  : Ms extends readonly [
        infer Head extends OracleMiddleware,
        ...infer Rest extends readonly OracleMiddleware[],
      ]
    ? Head extends OracleMiddleware<
        infer THeadIn extends RiskOracle,
        infer THeadOut extends RiskOracle
      >
      ? ChainOut<Rest> extends infer TRestOut extends RiskOracle
        ? TRestOut extends THeadIn
          ? THeadOut
          : never
        : never
      : never
    : never;

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
 * The result type is computed from the actual sequence of middleware types
 * passed in: a chain that is entirely detail-preserving/adding types its
 * result as `DetailedRiskOracle`, and a chain containing even one
 * plain-`RiskOracle`-only middleware types its result as plain `RiskOracle`
 * (so calling `.getScoreDetailed()` on it is a compile error) — see
 * {@link OracleMiddleware} for what determines each middleware's category.
 *
 * The recommended production order for the concerns planned in #6-#10, #27
 * and #41 is documented in the README ("Composing cross-cutting concerns").
 */
export function compose(): OracleMiddleware;
export function compose<Ms extends readonly [OracleMiddleware, ...OracleMiddleware[]]>(
  ...middlewares: Ms
): OracleMiddleware<InnermostIn<Ms>, ChainOut<Ms>>;
export function compose(...middlewares: readonly OracleMiddleware[]): OracleMiddleware {
  return (oracle: RiskOracle) =>
    middlewares.reduceRight((next, middleware) => middleware(next), oracle);
}
