import { DetailedRiskOracle, RiskOracle } from '../RiskOracle';
import { OracleMiddleware } from '../OracleMiddleware';
import { ProvenanceOracle, ProvenanceOracleOptions } from '../ProvenanceOracle';

/**
 * Provenance middleware: wraps `next` in a {@link ProvenanceOracle}. Typed as
 * `OracleMiddleware<RiskOracle, DetailedRiskOracle>` because
 * `ProvenanceOracle` implements `DetailedRiskOracle` unconditionally —
 * regardless of whether `next` itself is detailed — so this middleware
 * always *adds* the guarantee rather than merely forwarding one that was
 * already there. See {@link OracleMiddleware} for how this category differs
 * from a detail-preserving or plain-only middleware, and
 * `tests/type-tests/OracleMiddleware.type-test.ts` for compose chains built
 * from it.
 */
export function withProvenance(
  options?: ProvenanceOracleOptions,
): OracleMiddleware<RiskOracle, DetailedRiskOracle> {
  return (next: RiskOracle) => new ProvenanceOracle(next, options);
}
