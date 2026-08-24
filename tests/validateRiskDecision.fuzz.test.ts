import { describe, expect, it } from 'vitest';
import { seededRandom } from './support/seededRandom';
import { OracleError } from '../src/OracleError';
import { RISK_DECISION_SCHEMA_VERSION } from '../src/RiskDecision';
import { validateRiskDecision } from '../src/validateRiskDecision';

/**
 * Property-based-ish coverage for `validateRiskDecision`: starting from a
 * well-formed decision of a randomly chosen outcome, apply exactly one
 * randomly chosen malformation (bad score/confidence/time/source, or a
 * contradictory outcome/payload combination), and assert the validator
 * rejects it — every time, across many random combinations, not just the
 * handful of examples in `validateRiskDecision.test.ts`. Deterministic via
 * a seeded PRNG (`tests/support/seededRandom.ts`), matching this repo's
 * existing fuzz/property test style (see `tests/fuzz/`,
 * `tests/concurrency/`) so a failure is reproducible from its seed.
 */

const DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';
const NOW = 1_700_000_000_000;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function baseFor(outcome: string): Record<string, unknown> {
  const common = {
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: DESTINATION,
    source: 'fuzz-source',
    observedAt: NOW - 1_000,
  };
  switch (outcome) {
    case 'verified':
      return { ...common, outcome, score: 50, confidence: 0.5 };
    case 'unscored':
      return { ...common, outcome, reason: 'not-tracked' };
    case 'degraded':
      return {
        ...common,
        outcome,
        score: 30,
        degradationReason: 'stale',
        evidenceAt: NOW - 10_000,
      };
    case 'policy-blocked':
      return { ...common, outcome, policyRuleId: 'rule-1' };
    case 'unavailable':
      return { ...common, outcome, reason: 'timeout' };
    case 'incompatible':
      return { ...common, outcome, reportedSchemaVersion: 7 };
    default:
      throw new Error(`unreachable outcome: ${outcome}`);
  }
}

const OUTCOMES = [
  'verified',
  'unscored',
  'degraded',
  'policy-blocked',
  'unavailable',
  'incompatible',
] as const;

/** Each mutator takes a valid decision object and the shared rng, and returns an INVALID variant, or `undefined` if it doesn't apply to this outcome. */
const MUTATORS: Array<
  (decision: Record<string, unknown>, rng: () => number) => Record<string, unknown> | undefined
> = [
  // Bad score, for outcomes that carry one.
  (d, rng) =>
    'score' in d
      ? { ...d, score: pick(rng, [-1, 101, 50.5, NaN, Infinity, -Infinity, 'high']) }
      : undefined,
  // Bad confidence.
  (d, rng) =>
    d.outcome === 'verified' || d.outcome === 'degraded'
      ? { ...d, confidence: pick(rng, [-0.01, 1.01, NaN, Infinity, 'high']) }
      : undefined,
  // Bad observedAt.
  (d, rng) => ({
    ...d,
    observedAt: pick(rng, [NaN, Infinity, -Infinity, 'now', NOW + 60 * 60 * 1000]),
  }),
  // Missing/empty source.
  (d, rng) => ({ ...d, source: pick(rng, [undefined, '', 42, null]) }),
  // Missing/empty destination.
  (d, rng) => ({ ...d, destination: pick(rng, [undefined, '', 0]) }),
  // Contradictory: smuggle a numeric score onto an outcome that must not carry one.
  (d) => (d.outcome !== 'verified' && d.outcome !== 'degraded' ? { ...d, score: 10 } : undefined),
  // Wrong schemaVersion.
  (d, rng) => ({ ...d, schemaVersion: pick(rng, [0, 2, 999, 'v1']) }),
  // Unknown outcome string entirely.
  (d) => ({ ...d, outcome: 'not-a-real-outcome' }),
];

describe('validateRiskDecision fuzzer', () => {
  it('rejects every randomly-malformed decision across 2000 trials, for every outcome and mutator', () => {
    const rng = seededRandom(0x51deca5e);
    let trials = 0;

    for (let i = 0; i < 2000; i += 1) {
      const outcome = pick(rng, OUTCOMES);
      const valid = baseFor(outcome);

      // Sanity check: the unmutated base really is valid, so a failure
      // below can only be attributed to the mutation, not a broken fixture.
      expect(() => validateRiskDecision(valid, { now: () => NOW })).not.toThrow();

      let mutated: Record<string, unknown> | undefined;
      let attempts = 0;
      while (mutated === undefined && attempts < MUTATORS.length * 2) {
        const mutator = pick(rng, MUTATORS);
        mutated = mutator(valid, rng);
        attempts += 1;
      }
      if (mutated === undefined) continue; // every mutator declined for this outcome; extremely unlikely, just skip

      trials += 1;
      let threw = false;
      let thrownIsOracleError = false;
      try {
        validateRiskDecision(mutated, { now: () => NOW });
      } catch (err) {
        threw = true;
        thrownIsOracleError = err instanceof OracleError;
      }

      if (!threw || !thrownIsOracleError) {
        throw new Error(
          `Fuzzer found an accepted (or non-OracleError-throwing) malformed decision at trial ${i}: ` +
            `${JSON.stringify(mutated)}`,
        );
      }
    }

    expect(trials).toBeGreaterThan(1000);
  });

  it('rejects non-object payloads (null, arrays, primitives) unconditionally', () => {
    const rng = seededRandom(0xba5eba11);
    const nonObjects: unknown[] = [
      null,
      undefined,
      0,
      '',
      'string',
      true,
      [],
      [1, 2, 3],
      () => undefined,
    ];

    for (let i = 0; i < 200; i += 1) {
      const value = pick(rng, nonObjects);
      expect(() => validateRiskDecision(value, { now: () => NOW })).toThrow(OracleError);
    }
  });
});
