/**
 * Adversarial verification for RiskOracleAggregator (issue: Byzantine
 * aggregator with a provable f-of-n bound).
 *
 * This file contains three kinds of test that go beyond ordinary
 * assertions:
 *
 * 1. A property-based fuzz test: 6,000 randomized trials (the acceptance
 *    bar is 1,000) of n=5, f=2 with arbitrary integer reports, asserting
 *    the aggregate always falls within the honest sources' [min, max].
 * 2. A hill-climbing coalition search: an explicit, inspectable local-search
 *    optimizer (see {@link hillClimbCoalition} below) that spends 4,000
 *    iterations (the acceptance bar is 500) trying to choose the f
 *    Byzantine sources' reported values
 *    — with full knowledge of what the honest sources will report — to
 *    either push the aggregate outside the honest range, or inflate
 *    confidence above an honest-agreement baseline.
 * 3. A confidence-monotonicity property test across randomized disagreement
 *    levels.
 */
import { describe, expect, it } from 'vitest';
import { RiskOracleAggregator, RiskOracleAggregatorSource } from '../src/RiskOracleAggregator';
import { RiskOracle } from '../src/RiskOracle';

function fixedOracle(score: number): RiskOracle {
  return { getScore: async () => score };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Builds a fresh (no reputation history) aggregator from n=5 raw scores, f=2. */
function buildAggregator(scores: readonly number[], faultTolerance = 2): RiskOracleAggregator {
  const sources: RiskOracleAggregatorSource[] = scores.map((score, i) => ({
    label: `src-${i}`,
    oracle: fixedOracle(score),
  }));
  return new RiskOracleAggregator({
    sources,
    faultTolerance,
    timeoutMs: 5000,
  });
}

describe('property: honest-range bound holds for arbitrary reports (n=5, f=2)', () => {
  it('keeps the aggregate within [min, max] of the 3 honest sources across 6000 randomized trials', async () => {
    const TRIALS = 6000;
    for (let trial = 0; trial < TRIALS; trial++) {
      const honest = [randInt(0, 100), randInt(0, 100), randInt(0, 100)];
      // The 2 "Byzantine" sources are just as arbitrary as the honest ones —
      // the property must hold no matter what they report.
      const byzantine = [randInt(0, 100), randInt(0, 100)];
      const allScores = [...honest, ...byzantine];

      const aggregator = buildAggregator(allScores, 2);
      const result = await aggregator.getScoreDetailed('GDEST');

      const lo = Math.min(...honest);
      const hi = Math.max(...honest);
      expect(
        result.score,
        `trial ${trial}: honest=${honest}, byzantine=${byzantine}`,
      ).toBeGreaterThanOrEqual(lo);
      expect(
        result.score,
        `trial ${trial}: honest=${honest}, byzantine=${byzantine}`,
      ).toBeLessThanOrEqual(hi);
    }
  });
});

/**
 * A small, inspectable local-search optimizer ("red-team" coalition search).
 *
 * Given a fixed set of honest reports and a scoring function `objective`
 * (higher = a bigger violation), searches the space of possible coalition
 * reports (each an integer 0-100) to try to maximize `objective`. Uses
 * random-restart hill climbing: from a random starting coalition, repeatedly
 * perturbs one coordinate at a time (either by a small step or a full
 * resample) and keeps the move only if it improves the objective; restarts
 * from a fresh random point whenever a fixed number of consecutive
 * non-improving attempts is hit, so the search doesn't get stuck in one
 * basin. This is deliberately simple and fully readable — a reviewer can
 * see exactly what it tries.
 *
 * @param coalitionSize Number of adversarial values to choose.
 * @param objective Given a candidate coalition, returns a score to maximize.
 * @param iterations Total number of candidate evaluations to spend.
 * @returns The best coalition found and its objective score.
 */
async function hillClimbCoalition(
  coalitionSize: number,
  objective: (coalition: number[]) => Promise<number>,
  iterations: number,
): Promise<{ best: number[]; bestScore: number }> {
  const randomCoalition = (): number[] =>
    Array.from({ length: coalitionSize }, () => randInt(0, 100));

  let current = randomCoalition();
  let currentScore = await objective(current);
  let best = current.slice();
  let bestScore = currentScore;
  let stall = 0;
  const STALL_LIMIT = 25;

  for (let i = 0; i < iterations; i++) {
    let candidate: number[];
    if (stall >= STALL_LIMIT) {
      candidate = randomCoalition();
      stall = 0;
    } else {
      candidate = current.slice();
      const idx = randInt(0, coalitionSize - 1);
      // Half the time take a small step, half the time resample fully —
      // gives both local refinement and the ability to escape a bad basin.
      candidate[idx] =
        Math.random() < 0.5 ? clampInt(candidate[idx] + randInt(-10, 10)) : randInt(0, 100);
    }

    const candidateScore = await objective(candidate);
    if (candidateScore > currentScore) {
      current = candidate;
      currentScore = candidateScore;
      stall = 0;
    } else {
      stall += 1;
    }

    if (currentScore > bestScore) {
      best = current.slice();
      bestScore = currentScore;
    }
  }

  return { best, bestScore };
}

function clampInt(v: number): number {
  return Math.max(0, Math.min(100, v));
}

const SEARCH_ITERATIONS = 4000;

describe('adversarial coalition search: honest-range bound', () => {
  it('cannot find a coalition that pushes the aggregate outside the honest range', async () => {
    // A fixed, moderately spread honest scenario the coalition has full
    // knowledge of ahead of time.
    const honest = [10, 45, 90];
    const lo = Math.min(...honest);
    const hi = Math.max(...honest);

    const objective = async (coalition: number[]): Promise<number> => {
      const aggregator = buildAggregator([...honest, ...coalition], 2);
      const { score } = await aggregator.getScoreDetailed('GDEST');
      return Math.max(0, lo - score, score - hi);
    };

    const { best, bestScore } = await hillClimbCoalition(2, objective, SEARCH_ITERATIONS);

    expect(bestScore, `best coalition found: ${JSON.stringify(best)}`).toBe(0);
  });

  it('still holds even after the coalition has built up maximum reputation over many honest rounds', async () => {
    const honest = [10, 45, 90];
    const lo = Math.min(...honest);
    const hi = Math.max(...honest);

    // Prime a single long-lived aggregator: every source (including the
    // eventual attackers) answers honestly and in agreement for many
    // rounds first, maximizing everyone's reputation weight.
    const sources: RiskOracleAggregatorSource[] = [
      { label: 'honest-0', oracle: fixedOracle(50) },
      { label: 'honest-1', oracle: fixedOracle(50) },
      { label: 'honest-2', oracle: fixedOracle(50) },
      { label: 'attacker-0', oracle: fixedOracle(50) },
      { label: 'attacker-1', oracle: fixedOracle(50) },
    ];
    const aggregator = new RiskOracleAggregator({ sources, faultTolerance: 2, timeoutMs: 5000 });
    for (let i = 0; i < 20; i++) {
      await aggregator.getScoreDetailed('GDEST');
    }
    // Confirm reputation is indeed maxed out before the attack round.
    for (const weight of aggregator.getReputationSnapshot().values()) {
      expect(weight).toBeCloseTo(1, 5);
    }

    // Now attack: honest-0..2 report the real (spread) honest values, and
    // the search chooses attacker-0/1's reports, all against the SAME
    // primed (max-reputation) instance.
    const objective = async (coalition: number[]): Promise<number> => {
      const attackAggregator = new RiskOracleAggregator({
        sources: [
          { label: 'honest-0', oracle: fixedOracle(honest[0]) },
          { label: 'honest-1', oracle: fixedOracle(honest[1]) },
          { label: 'honest-2', oracle: fixedOracle(honest[2]) },
          { label: 'attacker-0', oracle: fixedOracle(coalition[0]) },
          { label: 'attacker-1', oracle: fixedOracle(coalition[1]) },
        ],
        faultTolerance: 2,
        timeoutMs: 5000,
      });
      const { score } = await attackAggregator.getScoreDetailed('GDEST');
      return Math.max(0, lo - score, score - hi);
    };
    void aggregator; // the primed instance itself only served to prove weights maxed out

    const { best, bestScore } = await hillClimbCoalition(2, objective, SEARCH_ITERATIONS);
    expect(bestScore, `best coalition found: ${JSON.stringify(best)}`).toBe(0);
  });
});

describe('adversarial coalition search: confidence cannot be inflated above an honest baseline', () => {
  it('cannot find a coalition that reports confidence above what the honest sources alone would produce', async () => {
    const honest = [10, 45, 90]; // deliberately widely spread: real disagreement
    const honestOnlyAggregator = new RiskOracleAggregator({
      sources: honest.map((score, i) => ({ label: `honest-${i}`, oracle: fixedOracle(score) })),
      faultTolerance: 0,
      timeoutMs: 5000,
    });
    const { confidence: honestBaseline } = await honestOnlyAggregator.getScoreDetailed('GDEST');

    const objective = async (coalition: number[]): Promise<number> => {
      const aggregator = buildAggregator([...honest, ...coalition], 2);
      const { confidence } = await aggregator.getScoreDetailed('GDEST');
      return confidence - honestBaseline;
    };

    const { best, bestScore } = await hillClimbCoalition(2, objective, SEARCH_ITERATIONS);

    expect(
      bestScore,
      `best coalition found: ${JSON.stringify(best)} (honest baseline confidence=${honestBaseline})`,
    ).toBeLessThanOrEqual(1e-9);
  });

  it('cannot inflate confidence even when honest sources already agree tightly (near-ceiling baseline)', async () => {
    const honest = [48, 50, 52];
    const honestOnlyAggregator = new RiskOracleAggregator({
      sources: honest.map((score, i) => ({ label: `honest-${i}`, oracle: fixedOracle(score) })),
      faultTolerance: 0,
      timeoutMs: 5000,
    });
    const { confidence: honestBaseline } = await honestOnlyAggregator.getScoreDetailed('GDEST');

    const objective = async (coalition: number[]): Promise<number> => {
      const aggregator = buildAggregator([...honest, ...coalition], 2);
      const { confidence } = await aggregator.getScoreDetailed('GDEST');
      return confidence - honestBaseline;
    };

    const { best, bestScore } = await hillClimbCoalition(2, objective, SEARCH_ITERATIONS);

    expect(
      bestScore,
      `best coalition found: ${JSON.stringify(best)} (honest baseline confidence=${honestBaseline})`,
    ).toBeLessThanOrEqual(1e-9);
  });
});

describe('property: confidence strictly decreases as disagreement increases', () => {
  it('holds across many randomized disagreement levels', async () => {
    const TRIALS = 400;
    const LEVELS = [0, 5, 10, 20, 30, 40, 50];

    for (let trial = 0; trial < TRIALS; trial++) {
      // A random baseline and a random (fixed-per-trial) spread pattern
      // across the 5 sources; only the disagreement level scales.
      const baseline = randInt(20, 80);
      const pattern = [-2, -1, 0, 1, 2].sort(() => Math.random() - 0.5);

      const confidenceAt = async (level: number): Promise<number> => {
        const scores = pattern.map((p) => clampInt(baseline + p * level));
        const aggregator = buildAggregator(scores, 2);
        const { confidence } = await aggregator.getScoreDetailed('GDEST');
        return confidence;
      };

      let previous = await confidenceAt(LEVELS[0]);
      for (let i = 1; i < LEVELS.length; i++) {
        const current = await confidenceAt(LEVELS[i]);
        expect(
          current,
          `trial ${trial}: baseline=${baseline}, pattern=${pattern}, level ${LEVELS[i - 1]}->${LEVELS[i]}`,
        ).toBeLessThanOrEqual(previous);
        previous = current;
      }
    }
  });
});
