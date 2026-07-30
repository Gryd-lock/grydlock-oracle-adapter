/**
 * Compile-time-only type tests for AllDetailed and the typedFallbackOracle
 * demo built on it. Nothing here is executed — see
 * OracleMiddleware.type-test.ts's file doc for the pattern.
 */
import { AllDetailed } from '../../src/AllDetailed';
import { typedFallbackOracle } from '../../src/TypedFallbackOracle';
import { DetailedRiskOracle, RiskOracle } from '../../src/RiskOracle';

/** Compiles only when `T` is exactly `true` — used to pin down AllDetailed's resolved value. */
type ExpectTrue<T extends true> = T;
/** Compiles only when `T` is exactly `false`. */
type ExpectFalse<T extends false> = T;

const plainOracle: RiskOracle = {
  async getScore() {
    return 1;
  },
};

const detailedOracle: DetailedRiskOracle = {
  async getScore() {
    return 1;
  },
  async getScoreDetailed() {
    return { score: 1, timestamp: 0, source: 'demo', cacheStatus: 'live' };
  },
};

type AllDetailedTuple = [DetailedRiskOracle, DetailedRiskOracle, DetailedRiskOracle];
type MixedTuple = [DetailedRiskOracle, RiskOracle];

// --- Every element DetailedRiskOracle-typed: resolves true.
export type AllDetailedTrueCase = ExpectTrue<AllDetailed<AllDetailedTuple>>;

// --- A mix of RiskOracle- and DetailedRiskOracle-typed elements: resolves false.
export type AllDetailedMixedCase = ExpectFalse<AllDetailed<MixedTuple>>;

// --- Same mixed case must NOT satisfy "true" — proving the check is meaningful,
// not vacuously passing regardless of input.
// @ts-expect-error — a mixed array is not AllDetailed; this must not resolve to true.
export type AllDetailedMixedIsNotTrueCase = ExpectTrue<AllDetailed<MixedTuple>>;

// --- Empty array: documented, chosen behavior is vacuous truth (see AllDetailed's doc).
export type AllDetailedEmptyCase = ExpectTrue<AllDetailed<[]>>;

// --- Wired into a real array-consuming constructor's type signature: an
// all-detailed chain statically yields DetailedRiskOracle...
const typedAllDetailed = typedFallbackOracle([detailedOracle, detailedOracle, detailedOracle]);
const typedAllDetailedAssertion: DetailedRiskOracle = typedAllDetailed;
void typedAllDetailedAssertion.getScoreDetailed('GDEST');

// ...while a mixed chain statically yields only RiskOracle, even though the
// FallbackOracle instance underneath always has getScoreDetailed at runtime —
// the type is deliberately conservative rather than lying.
const typedMixed = typedFallbackOracle([detailedOracle, plainOracle]);

// @ts-expect-error — typedMixed is plain RiskOracle; not every tier is provably detailed.
void typedMixed.getScoreDetailed('GDEST');
