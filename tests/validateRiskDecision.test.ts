import { describe, expect, it } from 'vitest';
import { ContractIncompatibilityError, RiskDecisionValidationError } from '../src/OracleError';
import { RISK_DECISION_SCHEMA_VERSION } from '../src/RiskDecision';
import { isValidRiskDecision, validateRiskDecision } from '../src/validateRiskDecision';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';
const NOW = 1_700_000_000_000;
const nowFn = () => NOW;

function validVerified(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'verified',
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: DESTINATION,
    source: 'soroban-v2',
    observedAt: NOW - 1_000,
    score: 42,
    ...overrides,
  };
}

function validUnscored(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'unscored',
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: DESTINATION,
    source: 'soroban-v2',
    observedAt: NOW - 1_000,
    reason: 'not-tracked',
    ...overrides,
  };
}

function validDegraded(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'degraded',
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: DESTINATION,
    source: 'soroban-v2',
    observedAt: NOW - 1_000,
    score: 20,
    degradationReason: 'stale',
    evidenceAt: NOW - 10_000,
    ...overrides,
  };
}

describe('validateRiskDecision — accepts well-formed decisions', () => {
  it('accepts a verified decision', () => {
    const decision = validateRiskDecision(validVerified(), { now: nowFn });
    expect(decision.outcome).toBe('verified');
  });

  it('accepts a verified decision with confidence, contractId, and expiresAt', () => {
    const decision = validateRiskDecision(
      validVerified({ confidence: 0.9, contractId: 'C123', expiresAt: NOW + 60_000 }),
      { now: nowFn },
    );
    expect(decision.outcome).toBe('verified');
  });

  it('accepts an unscored decision with no score field at all', () => {
    const decision = validateRiskDecision(validUnscored(), { now: nowFn });
    expect(decision.outcome).toBe('unscored');
  });

  it('accepts a degraded decision', () => {
    const decision = validateRiskDecision(validDegraded(), { now: nowFn });
    expect(decision.outcome).toBe('degraded');
  });

  it('accepts a policy-blocked decision with an embedded underlying verified decision', () => {
    const decision = validateRiskDecision(
      {
        outcome: 'policy-blocked',
        schemaVersion: RISK_DECISION_SCHEMA_VERSION,
        destination: DESTINATION,
        source: 'policy-engine',
        observedAt: NOW - 1_000,
        policyRuleId: 'warn-on-new-account',
        underlying: validVerified(),
      },
      { now: nowFn },
    );
    expect(decision.outcome).toBe('policy-blocked');
  });

  it('accepts an unavailable decision', () => {
    const decision = validateRiskDecision(
      {
        outcome: 'unavailable',
        schemaVersion: RISK_DECISION_SCHEMA_VERSION,
        destination: DESTINATION,
        source: 'soroban-v2',
        observedAt: NOW - 1_000,
        reason: 'timeout',
      },
      { now: nowFn },
    );
    expect(decision.outcome).toBe('unavailable');
  });

  it('accepts an incompatible decision', () => {
    const decision = validateRiskDecision(
      {
        outcome: 'incompatible',
        schemaVersion: RISK_DECISION_SCHEMA_VERSION,
        destination: DESTINATION,
        source: 'soroban-v2',
        observedAt: NOW - 1_000,
        reportedSchemaVersion: 99,
      },
      { now: nowFn },
    );
    expect(decision.outcome).toBe('incompatible');
  });
});

describe('validateRiskDecision — verified vs unscored are exhaustively distinct at runtime', () => {
  it('a verified decision and an unscored decision for the same destination validate to different outcomes', () => {
    const verified = validateRiskDecision(validVerified(), { now: nowFn });
    const unscored = validateRiskDecision(validUnscored(), { now: nowFn });

    expect(verified.outcome).not.toBe(unscored.outcome);
    expect(verified.outcome).toBe('verified');
    expect(unscored.outcome).toBe('unscored');
  });
});

describe('validateRiskDecision — schema version mismatch', () => {
  it('throws ContractIncompatibilityError for an unsupported schemaVersion, not RiskDecisionValidationError', () => {
    expect(() =>
      validateRiskDecision(validVerified({ schemaVersion: 999 }), { now: nowFn }),
    ).toThrow(ContractIncompatibilityError);
  });
});

describe('validateRiskDecision — malformed input is rejected', () => {
  const malformedCases: Array<[string, unknown]> = [
    ['null', null],
    ['a bare string', 'not-an-object'],
    ['an array', []],
    ['missing outcome', validVerified({ outcome: undefined })],
    ['unknown outcome', validVerified({ outcome: 'made-up' })],
    ['non-integer score', validVerified({ score: 42.5 })],
    ['score above 100', validVerified({ score: 101 })],
    ['score below 0', validVerified({ score: -1 })],
    ['NaN score', validVerified({ score: NaN })],
    ['Infinity score', validVerified({ score: Infinity })],
    ['out-of-range confidence (negative)', validVerified({ confidence: -0.1 })],
    ['out-of-range confidence (above 1)', validVerified({ confidence: 1.1 })],
    ['NaN confidence', validVerified({ confidence: NaN })],
    ['non-numeric observedAt', validVerified({ observedAt: 'yesterday' })],
    ['NaN observedAt', validVerified({ observedAt: NaN })],
    ['observedAt far in the future', validVerified({ observedAt: NOW + 10 * 60 * 1000 })],
    ['empty destination', validVerified({ destination: '' })],
    ['missing source', validVerified({ source: undefined })],
    ['empty source', validVerified({ source: '' })],
    ['degraded missing degradationReason', validDegraded({ degradationReason: undefined })],
    ['degraded missing evidenceAt', validDegraded({ evidenceAt: undefined })],
    [
      'policy-blocked missing policyRuleId',
      {
        outcome: 'policy-blocked',
        schemaVersion: RISK_DECISION_SCHEMA_VERSION,
        destination: DESTINATION,
        source: 's',
        observedAt: NOW - 1,
      },
    ],
    [
      'unavailable missing reason',
      {
        outcome: 'unavailable',
        schemaVersion: RISK_DECISION_SCHEMA_VERSION,
        destination: DESTINATION,
        source: 's',
        observedAt: NOW - 1,
      },
    ],
  ];

  it.each(malformedCases)('rejects: %s', (_label, input) => {
    expect(() => validateRiskDecision(input, { now: nowFn })).toThrow();
    expect(isValidRiskDecision(input, { now: nowFn })).toBe(false);
  });
});

describe('validateRiskDecision — outcome-vs-payload consistency (contradictory state)', () => {
  it('rejects an unscored decision that carries a numeric score', () => {
    expect(() => validateRiskDecision(validUnscored({ score: 10 }), { now: nowFn })).toThrow(
      RiskDecisionValidationError,
    );
  });

  it('rejects an unavailable decision that carries a numeric score', () => {
    expect(() =>
      validateRiskDecision(
        {
          outcome: 'unavailable',
          schemaVersion: RISK_DECISION_SCHEMA_VERSION,
          destination: DESTINATION,
          source: 's',
          observedAt: NOW - 1,
          reason: 'timeout',
          score: 10,
        },
        { now: nowFn },
      ),
    ).toThrow(RiskDecisionValidationError);
  });

  it('rejects an incompatible decision that carries a numeric score', () => {
    expect(() =>
      validateRiskDecision(
        {
          outcome: 'incompatible',
          schemaVersion: RISK_DECISION_SCHEMA_VERSION,
          destination: DESTINATION,
          source: 's',
          observedAt: NOW - 1,
          score: 10,
        },
        { now: nowFn },
      ),
    ).toThrow(RiskDecisionValidationError);
  });

  it('rejects a policy-blocked decision whose underlying is itself policy-blocked', () => {
    expect(() =>
      validateRiskDecision(
        {
          outcome: 'policy-blocked',
          schemaVersion: RISK_DECISION_SCHEMA_VERSION,
          destination: DESTINATION,
          source: 's',
          observedAt: NOW - 1,
          policyRuleId: 'rule-1',
          underlying: {
            outcome: 'policy-blocked',
            schemaVersion: RISK_DECISION_SCHEMA_VERSION,
            destination: DESTINATION,
            source: 's',
            observedAt: NOW - 1,
            policyRuleId: 'rule-2',
          },
        },
        { now: nowFn },
      ),
    ).toThrow(RiskDecisionValidationError);
  });
});

describe('validateRiskDecision — does not default a missing confidence to full trust', () => {
  it('accepts a verified decision with no confidence field at all, leaving it undefined rather than 1', () => {
    const decision = validateRiskDecision(validVerified(), { now: nowFn });
    expect(decision.outcome).toBe('verified');
    expect((decision as { confidence?: number }).confidence).toBeUndefined();
  });
});

describe('RiskDecisionValidationError', () => {
  it('carries the offending field on its context', () => {
    try {
      validateRiskDecision(validVerified({ score: 200 }), { now: nowFn });
      throw new Error('expected validateRiskDecision to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RiskDecisionValidationError);
      expect((error as RiskDecisionValidationError).context.field).toBe('score');
      expect((error as RiskDecisionValidationError).code).toBe('RISK_DECISION_INVALID');
    }
  });
});
