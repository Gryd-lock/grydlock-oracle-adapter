import { describe, expect, it } from 'vitest';
import {
  ContractIncompatibilityError,
  OracleUnavailableError,
  UnrecognizedDestinationError,
} from '../../src/OracleError';
import { RISK_DECISION_SCHEMA_VERSION, RiskDecision } from '../../src/RiskDecision';
import { toLegacyRiskOracle, toLegacyScore } from '../../src/legacy/numericAdapter';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

function decision(overrides: Partial<RiskDecision> & Pick<RiskDecision, 'outcome'>): RiskDecision {
  const base = {
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: DESTINATION,
    source: 'test',
    observedAt: 0,
  };
  return { ...base, ...overrides } as RiskDecision;
}

describe('toLegacyScore — fail-closed numeric compatibility adapter', () => {
  it('resolves a verified decision to its score', () => {
    const result = toLegacyScore(decision({ outcome: 'verified', score: 77 } as RiskDecision));
    expect(result).toBe(77);
  });

  it('rejects an unscored decision with UnrecognizedDestinationError', () => {
    expect(() => toLegacyScore(decision({ outcome: 'unscored' } as RiskDecision))).toThrow(
      UnrecognizedDestinationError,
    );
  });

  it('rejects an unavailable decision with OracleUnavailableError', () => {
    expect(() =>
      toLegacyScore(decision({ outcome: 'unavailable', reason: 'timeout' } as RiskDecision)),
    ).toThrow(OracleUnavailableError);
  });

  it('rejects an incompatible decision with ContractIncompatibilityError', () => {
    expect(() =>
      toLegacyScore(
        decision({ outcome: 'incompatible', reportedSchemaVersion: 99 } as RiskDecision),
      ),
    ).toThrow(ContractIncompatibilityError);
  });

  it('rejects a policy-blocked decision with ContractIncompatibilityError', () => {
    expect(() =>
      toLegacyScore(
        decision({ outcome: 'policy-blocked', policyRuleId: 'rule-1' } as RiskDecision),
      ),
    ).toThrow(ContractIncompatibilityError);
  });

  it('rejects a degraded decision by default (fail-closed)', () => {
    expect(() =>
      toLegacyScore(
        decision({
          outcome: 'degraded',
          score: 40,
          degradationReason: 'stale',
          evidenceAt: -1_000,
        } as RiskDecision),
      ),
    ).toThrow(ContractIncompatibilityError);
  });

  it('accepts a degraded decision only when acceptDegraded is explicitly true', () => {
    const result = toLegacyScore(
      decision({
        outcome: 'degraded',
        score: 40,
        degradationReason: 'stale',
        evidenceAt: -1_000,
      } as RiskDecision),
      { acceptDegraded: true },
    );
    expect(result).toBe(40);
  });

  it('never returns a number for the four non-numeric outcomes, even with acceptDegraded: true', () => {
    const outcomes: RiskDecision[] = [
      decision({ outcome: 'unscored' } as RiskDecision),
      decision({ outcome: 'unavailable', reason: 'timeout' } as RiskDecision),
      decision({ outcome: 'incompatible' } as RiskDecision),
      decision({ outcome: 'policy-blocked', policyRuleId: 'r' } as RiskDecision),
    ];

    for (const d of outcomes) {
      expect(() => toLegacyScore(d, { acceptDegraded: true })).toThrow();
    }
  });

  it('preserves the destination on the thrown error context', () => {
    try {
      toLegacyScore(
        decision({ outcome: 'unavailable', reason: 'transport-error' } as RiskDecision),
      );
      throw new Error('expected toLegacyScore to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OracleUnavailableError);
      expect((error as OracleUnavailableError).context.destination).toBe(DESTINATION);
    }
  });
});

describe('toLegacyRiskOracle', () => {
  it('adapts a RiskDecision producer into a RiskOracle for the verified case', async () => {
    const oracle = toLegacyRiskOracle(async () =>
      decision({ outcome: 'verified', score: 12 } as RiskDecision),
    );
    await expect(oracle.getScore(DESTINATION)).resolves.toBe(12);
  });

  it('propagates the fail-closed rejection through getScore', async () => {
    const oracle = toLegacyRiskOracle(async () =>
      decision({ outcome: 'unscored' } as RiskDecision),
    );
    await expect(oracle.getScore(DESTINATION)).rejects.toThrow(UnrecognizedDestinationError);
  });
});
