/**
 * Compile-time-only type tests for OracleMiddleware/compose's detail
 * propagation. Nothing here is executed — it exists purely to be type-
 * checked by `npm run typecheck` (see tsconfig.typetest.json) — so every
 * assertion is either a direct type-checked assignment/member access or a
 * `// @ts-expect-error` proving the compiler rejects what it should.
 */
import { compose } from '../../src/OracleMiddleware';
import { withTimeout } from '../../src/middleware/withTimeout';
import { withProvenance } from '../../src/middleware/withProvenance';
import { DetailedRiskOracle, RiskOracle } from '../../src/RiskOracle';

const plainOracle: RiskOracle = {
  async getScore() {
    return 1;
  },
};

// --- All detail-preserving/adding: a chain of 4 (not just 2) middlewares
// composed entirely from withProvenance must resolve to DetailedRiskOracle,
// proving the variadic case works for arbitrary length, not a fixed arity.

const allDetailed = compose(
  withProvenance(),
  withProvenance(),
  withProvenance(),
  withProvenance(),
)(plainOracle);

const allDetailedAssertion: DetailedRiskOracle = allDetailed;
void allDetailedAssertion.getScoreDetailed('GDEST');

// --- Mixed chain, provenance outermost: a plain-only middleware (withTimeout)
// buried inside a detail-adding outer layer still resolves Detailed, because
// the OUTERMOST layer is what the caller ultimately receives and
// withProvenance adds the guarantee unconditionally.

const provenanceOuter = compose(withProvenance(), withTimeout({ timeoutMs: 1_000 }))(plainOracle);

const provenanceOuterAssertion: DetailedRiskOracle = provenanceOuter;
void provenanceOuterAssertion.getScoreDetailed('GDEST');

// --- Mixed chain, plain middleware outermost (the other relative order):
// withTimeout as outermost layer erases whatever detail the inner layers
// produced, so the result must NOT statically expose getScoreDetailed.

const timeoutOuter = compose(withTimeout({ timeoutMs: 1_000 }), withProvenance())(plainOracle);

// @ts-expect-error — timeoutOuter is plain RiskOracle; getScoreDetailed does not exist on it.
void timeoutOuter.getScoreDetailed('GDEST');

// --- A longer (4-element) chain where the plain-only middleware is
// outermost: still resolves plain, confirming this isn't a fixed-length
// special case either.

const longMixedTimeoutOuter = compose(
  withTimeout({ timeoutMs: 1_000 }),
  withProvenance(),
  withProvenance(),
  withProvenance(),
)(plainOracle);

// @ts-expect-error — outermost layer is plain, so the whole chain's result is plain.
void longMixedTimeoutOuter.getScoreDetailed('GDEST');

// --- compose() with no arguments is the identity middleware; existing
// runtime behavior (tests/OracleMiddleware.test.ts) is unaffected — this is
// purely confirming the base RiskOracle case still type-checks.

const identityResult = compose()(plainOracle);
void identityResult.getScore('GDEST');
