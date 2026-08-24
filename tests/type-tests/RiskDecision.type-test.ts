/**
 * Compile-time-only type tests for `RiskDecision`'s exhaustiveness. Nothing
 * here is executed — it exists purely to be type-checked by
 * `npm run typecheck` (see tsconfig.typetest.json), matching the pattern in
 * `PublicApi.type-test.ts` and `OracleMiddleware.type-test.ts`: every
 * assertion is either a direct type-checked assignment/member access or a
 * `// @ts-expect-error` proving the compiler rejects what it should.
 */
import {
  DegradedRiskDecision,
  IncompatibleRiskDecision,
  PolicyBlockedRiskDecision,
  RISK_DECISION_SCHEMA_VERSION,
  RiskDecision,
  UnavailableRiskDecision,
  UnscoredRiskDecision,
  VerifiedRiskDecision,
} from '../../src/RiskDecision';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

const verified: VerifiedRiskDecision = {
  outcome: 'verified',
  schemaVersion: RISK_DECISION_SCHEMA_VERSION,
  destination: DESTINATION,
  source: 'test',
  observedAt: 0,
  score: 42,
};

const unscored: UnscoredRiskDecision = {
  outcome: 'unscored',
  schemaVersion: RISK_DECISION_SCHEMA_VERSION,
  destination: DESTINATION,
  source: 'test',
  observedAt: 0,
};

const degraded: DegradedRiskDecision = {
  outcome: 'degraded',
  schemaVersion: RISK_DECISION_SCHEMA_VERSION,
  destination: DESTINATION,
  source: 'test',
  observedAt: 0,
  score: 10,
  degradationReason: 'stale',
  evidenceAt: -1000,
};

const policyBlocked: PolicyBlockedRiskDecision = {
  outcome: 'policy-blocked',
  schemaVersion: RISK_DECISION_SCHEMA_VERSION,
  destination: DESTINATION,
  source: 'test',
  observedAt: 0,
  policyRuleId: 'warn-on-new-account',
  underlying: verified,
};

const unavailable: UnavailableRiskDecision = {
  outcome: 'unavailable',
  schemaVersion: RISK_DECISION_SCHEMA_VERSION,
  destination: DESTINATION,
  source: 'test',
  observedAt: 0,
  reason: 'timeout',
};

const incompatible: IncompatibleRiskDecision = {
  outcome: 'incompatible',
  schemaVersion: RISK_DECISION_SCHEMA_VERSION,
  destination: DESTINATION,
  source: 'test',
  observedAt: 0,
  reportedSchemaVersion: 99,
};

const decisions: RiskDecision[] = [
  verified,
  unscored,
  degraded,
  policyBlocked,
  unavailable,
  incompatible,
];
void decisions;

// --- Field access is narrowed per-variant: `score` only exists on
// verified/degraded, `policyRuleId` only on policy-blocked, etc.

if (verified.outcome === 'verified') {
  const score: number = verified.score;
  void score;
}

// @ts-expect-error — `score` does not exist on UnscoredRiskDecision.
void unscored.score;

// @ts-expect-error — `policyRuleId` does not exist on VerifiedRiskDecision.
void verified.policyRuleId;

// @ts-expect-error — `degradationReason` does not exist on UnavailableRiskDecision.
void unavailable.degradationReason;

// --- Exhaustiveness: a switch over every outcome, each arm returning, with
// NO `default` clause. If a `RiskDecision` variant were added (or removed)
// without a matching `case` here, this function would have a code path
// that doesn't return — a compile error (TS2366) even without a `default`,
// because the switch's exhaustiveness is what lets TypeScript treat "falls
// off the end" as reachable exactly when a case is missing.
function describeExhaustively(decision: RiskDecision): string {
  switch (decision.outcome) {
    case 'verified':
      return `verified:${decision.score}`;
    case 'unscored':
      return `unscored:${decision.reason ?? 'none'}`;
    case 'degraded':
      return `degraded:${decision.score}:${decision.degradationReason}`;
    case 'policy-blocked':
      return `policy-blocked:${decision.policyRuleId}`;
    case 'unavailable':
      return `unavailable:${decision.reason}`;
    case 'incompatible':
      return `incompatible:${decision.reportedSchemaVersion ?? 'unknown'}`;
  }
}
void describeExhaustively(verified);

// --- Negative proof: the same exhaustiveness switch, but with the
// `degraded` case deliberately omitted, assigned to a variable typed with
// an explicit return annotation. This must NOT compile — proving the
// positive case above is actually exercising exhaustiveness checking and
// not merely coincidentally compiling.
// @ts-expect-error — omitting the `degraded` case leaves a code path that doesn't return, which is a compile error given the explicit `: string` return type.
const describeIncompletely = (decision: RiskDecision): string => {
  switch (decision.outcome) {
    case 'verified':
      return `verified:${decision.score}`;
    case 'unscored':
      return `unscored:${decision.reason ?? 'none'}`;
    case 'policy-blocked':
      return `policy-blocked:${decision.policyRuleId}`;
    case 'unavailable':
      return `unavailable:${decision.reason}`;
    case 'incompatible':
      return `incompatible:${decision.reportedSchemaVersion ?? 'unknown'}`;
  }
};
void describeIncompletely;
