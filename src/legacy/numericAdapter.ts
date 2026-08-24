import { RiskOracle } from '../RiskOracle';
import {
  ContractIncompatibilityError,
  OracleUnavailableError,
  UnrecognizedDestinationError,
} from '../OracleError';
import { RiskDecision } from '../RiskDecision';

/**
 * Fail-closed bridge from the evidence-bearing {@link RiskDecision} contract
 * down to the legacy numeric `RiskOracle` (`Promise<number>`) contract.
 *
 * @deprecated This adapter exists only to let consumers who have not yet
 * migrated off the numeric contract keep working against a `RiskDecision`-
 * producing source. New call sites should consume `RiskDecision` directly
 * (see `RiskDecision.ts`, `validateRiskDecision.ts`) and handle every
 * outcome explicitly rather than collapsing back onto a number. See
 * `MIGRATION_NUMERIC_TO_EVIDENCE.md` for the full rationale and migration
 * guidance.
 *
 * ## Why fail-closed
 *
 * `StubOracle`/`DefaultOracle` map "no score exists" and "nothing is known"
 * onto a hardcoded `0` because `RiskOracle.getScore` has nowhere else to
 * put that information — the numeric contract has exactly one success
 * shape. This adapter refuses to repeat that: only `verified` (and,
 * opt-in, `degraded`) decisions resolve to a number. `unscored`,
 * `unavailable`, `incompatible`, and `policy-blocked` all **throw** —
 * mapped onto this package's existing error taxonomy (`OracleError.ts`) so
 * a caller catching `OracleUnavailableError`/`UnrecognizedDestinationError`
 * today keeps working — rather than silently defaulting to a score a
 * consumer might act on as if it meant something.
 */

/** Options for {@link toLegacyScore} / {@link toLegacyRiskOracle}. */
export interface NumericAdapterOptions {
  /**
   * Whether a `degraded` decision (a score exists, but the evidence behind
   * it is stale/insufficiently fresh) is allowed to resolve to a number
   * rather than throwing. Defaults to `false`: fail-closed by default,
   * exactly like `unscored`/`unavailable`/`incompatible`/`policy-blocked`.
   * Opting in accepts *any* degraded decision regardless of
   * `degradationReason` — a caller that needs finer-grained policy over
   * which kinds of degradation are acceptable should consume `RiskDecision`
   * directly instead of this adapter.
   */
  acceptDegraded?: boolean;
}

/**
 * Converts one {@link RiskDecision} to the legacy numeric score shape.
 *
 * @deprecated See the module doc.
 * @throws {UnrecognizedDestinationError} If `decision.outcome` is `"unscored"`.
 * @throws {OracleUnavailableError} If `decision.outcome` is `"unavailable"`.
 * @throws {ContractIncompatibilityError} If `decision.outcome` is `"incompatible"` or `"policy-blocked"`, or if it is `"degraded"` and `options.acceptDegraded` is not `true`.
 */
export function toLegacyScore(decision: RiskDecision, options: NumericAdapterOptions = {}): number {
  const { acceptDegraded = false } = options;

  switch (decision.outcome) {
    case 'verified':
      return decision.score;

    case 'degraded':
      if (acceptDegraded) {
        return decision.score;
      }
      throw new ContractIncompatibilityError(
        `Refusing to convert a "degraded" decision (reason: ${decision.degradationReason}) to a legacy ` +
          `numeric score without options.acceptDegraded === true.`,
        { destination: decision.destination },
      );

    case 'unscored':
      throw new UnrecognizedDestinationError(decision.destination, {
        cause: new Error(
          `The destination is valid but no score exists for it (reason: ${decision.reason ?? 'unspecified'}). ` +
            `The legacy numeric contract has no way to represent "unscored" distinctly from "unrecognized," ` +
            `so this adapter fails closed rather than defaulting to a number.`,
        ),
      });

    case 'policy-blocked':
      throw new ContractIncompatibilityError(
        `Refusing to convert a "policy-blocked" decision (rule: ${decision.policyRuleId}) to a legacy ` +
          `numeric score — a policy veto is not raw evidence and has no honest numeric representation.`,
        { destination: decision.destination },
      );

    case 'unavailable':
      throw new OracleUnavailableError(
        `The underlying evidence source is unavailable (reason: ${decision.reason}).`,
        {
          destination: decision.destination,
        },
      );

    case 'incompatible':
      throw new ContractIncompatibilityError(
        `Decision schemaVersion ${decision.reportedSchemaVersion ?? 'unknown'} is incompatible with this adapter.`,
        { destination: decision.destination },
      );
  }
}

/**
 * Adapts an async `RiskDecision` producer into a legacy `RiskOracle`, using
 * {@link toLegacyScore} to fail closed on every non-numeric outcome.
 *
 * @deprecated See the module doc.
 */
export function toLegacyRiskOracle(
  getDecision: (destination: string) => Promise<RiskDecision>,
  options: NumericAdapterOptions = {},
): RiskOracle {
  return {
    async getScore(destination: string): Promise<number> {
      const decision = await getDecision(destination);
      return toLegacyScore(decision, options);
    },
  };
}
