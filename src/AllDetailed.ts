import { DetailedRiskOracle, RiskOracle } from './RiskOracle';

/**
 * Homomorphic per-element check over a RiskOracle tuple/array: maps each
 * element to `true` if it is statically `DetailedRiskOracle`-typed, `false`
 * otherwise. Because this maps over `keyof T` for an array/tuple type `T`,
 * TypeScript treats it as homomorphic and preserves the array/tuple shape
 * (length and per-index element types), rather than distributing over
 * `length`/`push`/etc. the way a naive `keyof` mapped type would for a
 * non-array object type.
 */
type ElementIsDetailed<T extends readonly RiskOracle[]> = {
  [K in keyof T]: T[K] extends DetailedRiskOracle ? true : false;
};

/**
 * Resolves to `true` only when every element of `T` is statically
 * `DetailedRiskOracle`-typed, and to `false` the moment any element is only
 * `RiskOracle`-typed — the array-level analogue of {@link OracleMiddleware}
 * chain composition's detail-propagation for the `FallbackOracle`/
 * `RiskOracleAggregator` "array of tiers" shape.
 *
 * An empty array resolves to `true` (vacuously detailed). This matches the
 * standard convention for a universally-quantified property over an empty
 * set — the same convention `[].every(predicate) === true` uses at
 * runtime — and is otherwise moot in practice: a chain of zero tiers has no
 * runtime meaning to preserve either (see `FallbackOracle.route`'s
 * empty-chain error).
 */
export type AllDetailed<T extends readonly RiskOracle[]> =
  false extends ElementIsDetailed<T>[number] ? false : true;
