import { ContractIncompatibilityError, RiskDecisionValidationError } from './OracleError';
import {
  DegradedRiskDecision,
  IncompatibleRiskDecision,
  PolicyBlockedRiskDecision,
  RISK_DECISION_SCHEMA_VERSION,
  RiskDecision,
  RiskDecisionOutcome,
  RiskDecisionSchemaVersion,
  UnavailableRiskDecision,
  UnscoredRiskDecision,
  VerifiedRiskDecision,
} from './RiskDecision';

/**
 * Runtime conformance validators for {@link RiskDecision}, for use at any
 * trust boundary: a third-party `RiskOracle`-like source, a caller about to
 * hand a result to a cache or `RiskOracleAggregator`, or a deserialized
 * value crossing a process/network boundary. TypeScript's compile-time
 * exhaustiveness (`RiskDecision.ts`) guarantees nothing at runtime about a
 * value that merely *claims* to be a `RiskDecision` — `as RiskDecision` on
 * unvalidated JSON is exactly how a malformed third-party payload would
 * silently reach an aggregator or a cache. These functions close that gap:
 * malformed input throws {@link RiskDecisionValidationError} (or
 * {@link ContractIncompatibilityError} for a schema-version mismatch)
 * instead of being coerced or passed through.
 *
 * Deliberately does NOT default a missing `confidence` to `1`. Contrast
 * with `middleware/withCache.ts`'s `defaultConfidence` (which *does*
 * default absence to `1` for the legacy `ScoredResult` contract) — that
 * assumption is legacy-only and must not leak into this validator: absence
 * of `confidence` here means "no confidence signal reported," never "full
 * trust."
 */

const VALID_OUTCOMES: readonly RiskDecisionOutcome[] = [
  'verified',
  'unscored',
  'degraded',
  'policy-blocked',
  'unavailable',
  'incompatible',
];

/** Options for {@link validateRiskDecision}. */
export interface ValidateRiskDecisionOptions {
  /** Clock returning epoch milliseconds, used to sanity-check timestamps aren't absurdly far in the future. Injectable for tests. */
  now?: () => number;
  /**
   * How far into the future, in milliseconds, a timestamp field may sit
   * before being rejected as nonsensical. Generous by default (5 minutes)
   * to tolerate real clock skew between independent sources without
   * rejecting legitimate evidence.
   */
  maxClockSkewMs?: number;
  /** How many levels of `policy-blocked.underlying` nesting to validate before giving up. Defaults to 4; deeper nesting is rejected rather than recursed into indefinitely. */
  maxDepth?: number;
}

function fail(field: string, message: string, value?: unknown): never {
  throw new RiskDecisionValidationError(message, {
    field,
    value: value === undefined ? undefined : safeStringify(value),
  });
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    // Defensive cap: a malformed/hostile payload shouldn't be able to blow
    // up an error message (and anything logging it) with an enormous value.
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireInteger0To100(value: unknown, field: string): number {
  if (isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 100) {
    return value;
  }
  fail(field, `"${field}" must be an integer in [0, 100]; got ${safeStringify(value)}.`, value);
}

function checkOptionalConfidence(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (isFiniteNumber(value) && value >= 0 && value <= 1) {
    return value;
  }
  fail(
    field,
    `"${field}" must be a finite number in [0, 1] when present; got ${safeStringify(value)}.`,
    value,
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  fail(field, `"${field}" must be a non-empty string; got ${safeStringify(value)}.`, value);
}

function checkOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  fail(
    field,
    `"${field}" must be a non-empty string when present; got ${safeStringify(value)}.`,
    value,
  );
}

function checkOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (isFiniteNumber(value) && Number.isInteger(value)) {
    return value;
  }
  fail(field, `"${field}" must be an integer when present; got ${safeStringify(value)}.`, value);
}

function requireTimestamp(
  value: unknown,
  field: string,
  now: number,
  maxClockSkewMs: number,
): number {
  if (!isFiniteNumber(value) || value < 0) {
    fail(
      field,
      `"${field}" must be a finite, non-negative epoch-ms timestamp; got ${safeStringify(value)}.`,
      value,
    );
  }
  const numeric = value as number;
  if (numeric > now + maxClockSkewMs) {
    fail(
      field,
      `"${field}" (${numeric}) is further in the future than the allowed clock skew (${maxClockSkewMs}ms past ${now}).`,
      numeric,
    );
  }
  return numeric;
}

function requireNoScoreField(input: Record<string, unknown>, outcome: string): void {
  if ('score' in input && input.score !== undefined) {
    fail(
      'score',
      `outcome "${outcome}" must not carry a numeric "score" — that combination is contradictory.`,
      input.score,
    );
  }
}

/**
 * Validates that `input` conforms to the {@link RiskDecision} contract,
 * including outcome-vs-payload consistency (e.g. an `unscored` decision
 * must not carry a numeric `score`), and returns it narrowed to
 * `RiskDecision` on success.
 *
 * @throws {ContractIncompatibilityError} If `schemaVersion` does not match
 * a version this validator supports.
 * @throws {RiskDecisionValidationError} If any other field is missing,
 * malformed, or the payload is internally contradictory.
 */
export function validateRiskDecision(
  input: unknown,
  options: ValidateRiskDecisionOptions = {},
): RiskDecision {
  const now = (options.now ?? Date.now)();
  const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60 * 1000;
  const maxDepth = options.maxDepth ?? 4;

  return validateAtDepth(input, now, maxClockSkewMs, maxDepth);
}

function validateAtDepth(
  input: unknown,
  now: number,
  maxClockSkewMs: number,
  depthRemaining: number,
): RiskDecision {
  if (!isPlainObject(input)) {
    fail('$', `A RiskDecision must be a plain object; got ${safeStringify(input)}.`, input);
  }

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== RISK_DECISION_SCHEMA_VERSION) {
    throw new ContractIncompatibilityError(
      `RiskDecision.schemaVersion ${safeStringify(schemaVersion)} is not supported by this validator ` +
        `(expected ${RISK_DECISION_SCHEMA_VERSION}).`,
    );
  }

  const outcome = input.outcome;
  if (typeof outcome !== 'string' || !VALID_OUTCOMES.includes(outcome as RiskDecisionOutcome)) {
    fail(
      'outcome',
      `"outcome" must be one of ${VALID_OUTCOMES.join(', ')}; got ${safeStringify(outcome)}.`,
      outcome,
    );
  }

  const destination = requireNonEmptyString(input.destination, 'destination');
  const source = requireNonEmptyString(input.source, 'source');
  const observedAt = requireTimestamp(input.observedAt, 'observedAt', now, maxClockSkewMs);

  // `schemaVersion` was already checked equal to the supported constant
  // above; using the constant directly (rather than relying on narrowing
  // `unknown` through the `!==` check) keeps `base`'s type unambiguous. The
  // explicit annotation keeps `schemaVersion` at its literal type instead
  // of widening to `number` the way a plain object-literal property would.
  const base: {
    schemaVersion: RiskDecisionSchemaVersion;
    destination: string;
    source: string;
    observedAt: number;
  } = {
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination,
    source,
    observedAt,
  };

  switch (outcome as RiskDecisionOutcome) {
    case 'verified': {
      const score = requireInteger0To100(input.score, 'score');
      const confidence = checkOptionalConfidence(input.confidence, 'confidence');
      const contractId = checkOptionalString(input.contractId, 'contractId');
      const expiresAt =
        input.expiresAt === undefined
          ? undefined
          : requireTimestamp(input.expiresAt, 'expiresAt', now, maxClockSkewMs);
      const decision: VerifiedRiskDecision = {
        ...base,
        outcome: 'verified',
        score,
        confidence,
        contractId,
        expiresAt,
      };
      return decision;
    }

    case 'unscored': {
      requireNoScoreField(input, 'unscored');
      const reason = checkOptionalString(input.reason, 'reason') as UnscoredRiskDecision['reason'];
      const decision: UnscoredRiskDecision = { ...base, outcome: 'unscored', reason };
      return decision;
    }

    case 'degraded': {
      const score = requireInteger0To100(input.score, 'score');
      const confidence = checkOptionalConfidence(input.confidence, 'confidence');
      const degradationReason = requireNonEmptyString(
        input.degradationReason,
        'degradationReason',
      ) as DegradedRiskDecision['degradationReason'];
      const evidenceAt = requireTimestamp(input.evidenceAt, 'evidenceAt', now, maxClockSkewMs);
      if (evidenceAt > observedAt + maxClockSkewMs) {
        fail(
          'evidenceAt',
          `"evidenceAt" (${evidenceAt}) must not be after "observedAt" (${observedAt}) beyond allowed clock skew.`,
          evidenceAt,
        );
      }
      const decision: DegradedRiskDecision = {
        ...base,
        outcome: 'degraded',
        score,
        confidence,
        degradationReason,
        evidenceAt,
      };
      return decision;
    }

    case 'policy-blocked': {
      requireNoScoreField(input, 'policy-blocked');
      const policyRuleId = requireNonEmptyString(input.policyRuleId, 'policyRuleId');
      let underlying: PolicyBlockedRiskDecision['underlying'];
      if (input.underlying !== undefined) {
        if (depthRemaining <= 0) {
          fail('underlying', 'Maximum RiskDecision nesting depth exceeded.', input.underlying);
        }
        const validatedUnderlying = validateAtDepth(
          input.underlying,
          now,
          maxClockSkewMs,
          depthRemaining - 1,
        );
        if (
          validatedUnderlying.outcome !== 'verified' &&
          validatedUnderlying.outcome !== 'degraded' &&
          validatedUnderlying.outcome !== 'unscored'
        ) {
          fail(
            'underlying.outcome',
            `"underlying" must be a verified/degraded/unscored decision, not "${validatedUnderlying.outcome}".`,
            validatedUnderlying.outcome,
          );
        }
        underlying = validatedUnderlying;
      }
      const decision: PolicyBlockedRiskDecision = {
        ...base,
        outcome: 'policy-blocked',
        policyRuleId,
        underlying,
      };
      return decision;
    }

    case 'unavailable': {
      requireNoScoreField(input, 'unavailable');
      const reason = requireNonEmptyString(
        input.reason,
        'reason',
      ) as UnavailableRiskDecision['reason'];
      const decision: UnavailableRiskDecision = { ...base, outcome: 'unavailable', reason };
      return decision;
    }

    case 'incompatible': {
      requireNoScoreField(input, 'incompatible');
      const reportedSchemaVersion = checkOptionalInteger(
        input.reportedSchemaVersion,
        'reportedSchemaVersion',
      );
      const detail = checkOptionalString(input.detail, 'detail');
      const decision: IncompatibleRiskDecision = {
        ...base,
        outcome: 'incompatible',
        reportedSchemaVersion,
        detail,
      };
      return decision;
    }
  }
}

/** True when `input` passes {@link validateRiskDecision} without throwing. Never throws itself. */
export function isValidRiskDecision(
  input: unknown,
  options?: ValidateRiskDecisionOptions,
): input is RiskDecision {
  try {
    validateRiskDecision(input, options);
    return true;
  } catch {
    return false;
  }
}
