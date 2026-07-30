import { AllDetailed } from './AllDetailed';
import { FallbackBanditConfig, FallbackOracle } from './FallbackOracle';
import { FallbackObserver } from './FallbackObserver';
import { DetailedRiskOracle, RiskOracle } from './RiskOracle';

/**
 * Typed variant of {@link FallbackOracle}'s constructor, demonstrating
 * {@link AllDetailed} wired into a real array-consuming constructor.
 *
 * The declared return type is `DetailedRiskOracle` only when every tier in
 * `chain` is statically `DetailedRiskOracle`-typed, and plain `RiskOracle`
 * the moment even one tier isn't provably detailed — computed from
 * `chain`'s actual per-element types. Because `chain` is inferred through
 * the generic `T` rather than annotated as
 * `readonly (RiskOracle | DetailedRiskOracle)[]`, each element keeps its own
 * precise type instead of being eagerly widened to that union, which is
 * what lets {@link AllDetailed} tell a fully-detailed chain apart from a
 * mixed one at the type level.
 *
 * This does not change `FallbackOracle`'s runtime behavior: the instance it
 * constructs already always implements `DetailedRiskOracle` (it duck-types
 * each tier internally — see `FallbackOracle.route`). What this adds is a
 * purely static, conservative *promise* to callers: detailed-typed only
 * when the compiler can actually prove it, plain `RiskOracle` otherwise
 * (never the other way around, which would be a lie).
 */
export function typedFallbackOracle<T extends readonly RiskOracle[]>(
  chain: T,
  observer?: FallbackObserver,
  config?: FallbackBanditConfig,
): AllDetailed<T> extends true ? DetailedRiskOracle : RiskOracle;
export function typedFallbackOracle(
  chain: readonly RiskOracle[],
  observer?: FallbackObserver,
  config: FallbackBanditConfig = {},
): RiskOracle {
  return new FallbackOracle(chain, observer, config);
}
