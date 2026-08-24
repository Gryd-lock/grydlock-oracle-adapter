import { describe, expect, it } from 'vitest';
import {
  DegradedRiskDecision,
  RISK_DECISION_SCHEMA_VERSION,
  RiskDecision,
  UnscoredRiskDecision,
  VerifiedRiskDecision,
  isScoredRiskDecision,
} from '../src/RiskDecision';

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

function base<Outcome extends string>(outcome: Outcome) {
  return {
    outcome,
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: DESTINATION,
    source: 'test',
    observedAt: 1_000,
  } as const;
}

describe('RiskDecision', () => {
  it('is verified vs unscored distinctly at runtime — verified carries a score, unscored does not', () => {
    const verified: VerifiedRiskDecision = { ...base('verified'), score: 50 };
    const unscored: UnscoredRiskDecision = { ...base('unscored'), reason: 'not-tracked' };

    expect(verified.outcome).toBe('verified');
    expect('score' in verified).toBe(true);
    expect(unscored.outcome).toBe('unscored');
    expect('score' in unscored).toBe(false);

    // Not merely absent — an unscored decision is a different shape
    // entirely, never "score: 0" or "score: undefined" standing in for
    // "nothing is known."
    expect((unscored as Partial<VerifiedRiskDecision>).score).toBeUndefined();
  });

  it('isScoredRiskDecision is true only for verified/degraded', () => {
    const verified: VerifiedRiskDecision = { ...base('verified'), score: 50 };
    const degraded: DegradedRiskDecision = {
      ...base('degraded'),
      score: 10,
      degradationReason: 'stale',
      evidenceAt: 0,
    };
    const unscored: UnscoredRiskDecision = { ...base('unscored') };

    const decisions: RiskDecision[] = [verified, degraded, unscored];

    expect(decisions.filter(isScoredRiskDecision)).toEqual([verified, degraded]);
  });

  it('every RiskDecision carries the same schemaVersion', () => {
    const verified: VerifiedRiskDecision = { ...base('verified'), score: 1 };
    expect(verified.schemaVersion).toBe(RISK_DECISION_SCHEMA_VERSION);
  });
});
