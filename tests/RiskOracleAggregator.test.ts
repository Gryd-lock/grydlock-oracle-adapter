import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RiskOracleAggregator,
  RiskOracleAggregatorSource,
  computeDisagreement,
  honestOrderBounds,
  weightedMedian,
} from '../src/RiskOracleAggregator';
import { QuorumNotMetError } from '../src/OracleError';
import { ProvenanceOracle } from '../src/ProvenanceOracle';
import { RiskOracle } from '../src/RiskOracle';

function fixedOracle(score: number): RiskOracle {
  return { getScore: async () => score };
}

function failingOracle(message: string): RiskOracle {
  return {
    getScore: async () => {
      throw new Error(message);
    },
  };
}

function hangingOracle(): RiskOracle {
  return { getScore: () => new Promise<number>(() => {}) };
}

function sourcesOf(scores: readonly number[]): RiskOracleAggregatorSource[] {
  return scores.map((score, i) => ({ label: `s${i}`, oracle: fixedOracle(score) }));
}

describe('RiskOracleAggregator construction', () => {
  it('throws when sources.length < 2*faultTolerance+1', () => {
    expect(
      () =>
        new RiskOracleAggregator({
          sources: sourcesOf([10, 20, 30]),
          faultTolerance: 2, // needs 5
          timeoutMs: 100,
        }),
    ).toThrow(/requires at least 5/);
  });

  it('throws when quorum is below the safe minimum', () => {
    expect(
      () =>
        new RiskOracleAggregator({
          sources: sourcesOf([10, 20, 30, 40, 50]),
          faultTolerance: 2,
          quorum: 3, // must be >= 2*2+1 = 5
          timeoutMs: 100,
        }),
    ).toThrow(/quorum must be between 5/);
  });

  it('throws when quorum exceeds the source count', () => {
    expect(
      () =>
        new RiskOracleAggregator({
          sources: sourcesOf([10, 20, 30]),
          faultTolerance: 0,
          quorum: 4,
          timeoutMs: 100,
        }),
    ).toThrow(/quorum must be between/);
  });

  it('throws on duplicate source labels', () => {
    expect(
      () =>
        new RiskOracleAggregator({
          sources: [
            { label: 'dup', oracle: fixedOracle(1) },
            { label: 'dup', oracle: fixedOracle(2) },
            { label: 'c', oracle: fixedOracle(3) },
          ],
          faultTolerance: 0,
          timeoutMs: 100,
        }),
    ).toThrow(/duplicate source label/);
  });

  it('throws on a negative or non-integer faultTolerance', () => {
    expect(
      () =>
        new RiskOracleAggregator({
          sources: sourcesOf([1, 2, 3]),
          faultTolerance: 1.5,
          timeoutMs: 100,
        }),
    ).toThrow(/faultTolerance must be a non-negative integer/);
  });

  it('throws on a non-positive timeoutMs', () => {
    expect(
      () =>
        new RiskOracleAggregator({
          sources: sourcesOf([1, 2, 3]),
          faultTolerance: 1,
          timeoutMs: 0,
        }),
    ).toThrow(/timeoutMs must be > 0/);
  });
});

describe('RiskOracleAggregator basic aggregation', () => {
  it('returns the (weighted) median when all sources agree closely', async () => {
    const aggregator = new RiskOracleAggregator({
      sources: sourcesOf([48, 50, 52]),
      faultTolerance: 1,
      timeoutMs: 1000,
    });

    const result = await aggregator.getScoreDetailed('GDEST');
    expect(result.score).toBe(50);
    expect(result.source).toBe('RiskOracleAggregator');
    expect(result.cacheStatus).toBe('live');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('getScore delegates to getScoreDetailed().score', async () => {
    const aggregator = new RiskOracleAggregator({
      sources: sourcesOf([10, 10, 10]),
      faultTolerance: 1,
      timeoutMs: 1000,
    });

    await expect(aggregator.getScore('GDEST')).resolves.toBe(10);
  });

  it('tolerates faultTolerance faulty sources reporting extreme values', async () => {
    // 3 honest sources cluster near 20; 2 Byzantine sources report 0 and 100.
    const aggregator = new RiskOracleAggregator({
      sources: [
        { label: 'honest-1', oracle: fixedOracle(18) },
        { label: 'honest-2', oracle: fixedOracle(20) },
        { label: 'honest-3', oracle: fixedOracle(22) },
        { label: 'byzantine-1', oracle: fixedOracle(0) },
        { label: 'byzantine-2', oracle: fixedOracle(100) },
      ],
      faultTolerance: 2,
      timeoutMs: 1000,
    });

    const result = await aggregator.getScoreDetailed('GDEST');
    expect(result.score).toBeGreaterThanOrEqual(18);
    expect(result.score).toBeLessThanOrEqual(22);
  });

  it('treats a non-finite reported score as a source failure, not a corrupting value', async () => {
    const aggregator = new RiskOracleAggregator({
      sources: [
        { label: 'a', oracle: fixedOracle(50) },
        { label: 'b', oracle: fixedOracle(52) },
        { label: 'c', oracle: fixedOracle(51) },
        { label: 'nan', oracle: fixedOracle(NaN) },
      ],
      faultTolerance: 1,
      timeoutMs: 1000,
    });

    const result = await aggregator.getScoreDetailed('GDEST');
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThanOrEqual(52);
  });
});

describe('RiskOracleAggregator quorum failure', () => {
  it('throws QuorumNotMetError when every source fails', async () => {
    const aggregator = new RiskOracleAggregator({
      sources: [
        { label: 'a', oracle: failingOracle('a down') },
        { label: 'b', oracle: failingOracle('b down') },
        { label: 'c', oracle: failingOracle('c down') },
      ],
      faultTolerance: 1,
      timeoutMs: 1000,
    });

    const error = await aggregator.getScoreDetailed('GDEST').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuorumNotMetError);
    const quorumError = error as QuorumNotMetError;
    expect(quorumError.code).toBe('QUORUM_NOT_MET');
    expect(quorumError.context.required).toBe(3);
    expect(quorumError.context.succeeded).toBe(0);
    expect(quorumError.context.total).toBe(3);
    // Failure is declared as soon as reaching quorum becomes impossible, so
    // not every source is guaranteed to have settled yet — at least one
    // failure reason must be captured, but not necessarily all three.
    expect(Object.keys(quorumError.context.failures ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it('throws QuorumNotMetError when successes fall short of quorum', async () => {
    const aggregator = new RiskOracleAggregator({
      sources: [
        { label: 'a', oracle: fixedOracle(50) },
        { label: 'b', oracle: failingOracle('b down') },
        { label: 'c', oracle: failingOracle('c down') },
        { label: 'd', oracle: failingOracle('d down') },
        { label: 'e', oracle: failingOracle('e down') },
      ],
      faultTolerance: 2, // quorum defaults to 5
      timeoutMs: 1000,
    });

    await expect(aggregator.getScoreDetailed('GDEST')).rejects.toBeInstanceOf(QuorumNotMetError);
  });
});

describe('RiskOracleAggregator latency bound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves quickly when a hung source is not needed to reach quorum', async () => {
    // n=4, f=1 -> quorum defaults to 3, so the 4th (hung) source has slack.
    const aggregator = new RiskOracleAggregator({
      sources: [
        { label: 'fast-1', oracle: fixedOracle(10) },
        { label: 'fast-2', oracle: fixedOracle(12) },
        { label: 'fast-3', oracle: fixedOracle(11) },
        { label: 'hung', oracle: hangingOracle() },
      ],
      faultTolerance: 1,
      timeoutMs: 60_000, // deliberately huge — the test asserts we never wait for it
    });

    let resolved = false;
    const pending = aggregator.getScoreDetailed('GDEST').then((r) => {
      resolved = true;
      return r;
    });

    // Let the fast, already-resolved promises flush without advancing timers.
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);

    const result = await pending;
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.score).toBeLessThanOrEqual(12);
  });

  it('bounds worst-case wait to the per-source timeout when quorum needs the hung source', async () => {
    // n=3, f=1 -> quorum defaults to 3 = n: every source must answer.
    const aggregator = new RiskOracleAggregator({
      sources: [
        { label: 'fast-1', oracle: fixedOracle(10) },
        { label: 'fast-2', oracle: fixedOracle(12) },
        { label: 'hung', oracle: hangingOracle() },
      ],
      faultTolerance: 1,
      timeoutMs: 1000,
    });

    let settled = false;
    const pending = aggregator.getScoreDetailed('GDEST').catch((e: unknown) => e);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false); // still waiting on the hung source's timeout

    await vi.advanceTimersByTimeAsync(600);
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(QuorumNotMetError);
  });
});

describe('RiskOracleAggregator + ProvenanceOracle composition', () => {
  it('produces a correct provenance record with zero changes to ProvenanceOracle', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const oracle = new ProvenanceOracle(
      new RiskOracleAggregator({
        sources: sourcesOf([40, 42, 44]),
        faultTolerance: 1,
        timeoutMs: 1000,
      }),
      { logger },
    );

    const score = await oracle.getScore('GDEST');
    expect(score).toBe(42);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [, fields] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.source).toBe('RiskOracleAggregator');
    expect(fields.cacheStatus).toBe('live');
    expect(fields.score).toBe(42);
    expect(fields.outcome).toBe('success');
  });

  it('logs an error outcome when the aggregator cannot reach quorum', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const oracle = new ProvenanceOracle(
      new RiskOracleAggregator({
        sources: [
          { label: 'a', oracle: failingOracle('down') },
          { label: 'b', oracle: failingOracle('down') },
          { label: 'c', oracle: failingOracle('down') },
        ],
        faultTolerance: 1,
        timeoutMs: 1000,
      }),
      { logger },
    );

    await expect(oracle.getScore('GDEST')).rejects.toBeInstanceOf(QuorumNotMetError);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.outcome).toBe('error');
  });
});

describe('RiskOracleAggregator reputation lifecycle', () => {
  it('starts every source at full trust (weight 1) before any call', () => {
    const aggregator = new RiskOracleAggregator({
      sources: sourcesOf([10, 20, 30]),
      faultTolerance: 1,
      timeoutMs: 1000,
    });

    const snapshot = aggregator.getReputationSnapshot();
    expect(snapshot.get('s0')).toBe(1);
    expect(snapshot.get('s1')).toBe(1);
    expect(snapshot.get('s2')).toBe(1);
  });

  it('down-weights a source that repeatedly disagrees with the aggregate more than one that agrees', async () => {
    // n=5, f=1, quorum=5 (force every source to count every round): 3
    // always-agreeing sources anchor the aggregate at 0; a 4th consistently
    // disagrees maximally (reports 100), a 5th consistently agrees (0).
    const oracles: Record<string, RiskOracle> = {
      anchor1: fixedOracle(0),
      anchor2: fixedOracle(0),
      anchor3: fixedOracle(0),
      disagreer: fixedOracle(100),
      agreer: fixedOracle(0),
    };
    const aggregator = new RiskOracleAggregator({
      sources: Object.entries(oracles).map(([label, oracle]) => ({ label, oracle })),
      faultTolerance: 1,
      quorum: 5,
      timeoutMs: 1000,
    });

    for (let i = 0; i < 15; i++) {
      await aggregator.getScoreDetailed('GDEST');
    }

    const snapshot = aggregator.getReputationSnapshot();
    const disagreerWeight = snapshot.get('disagreer')!;
    const agreerWeight = snapshot.get('agreer')!;

    expect(disagreerWeight).toBeLessThan(agreerWeight);
    expect(disagreerWeight).toBeCloseTo(0.1, 1); // converges toward the configured floor
    expect(agreerWeight).toBeCloseTo(1, 5);
  });

  it('reduces a source toward the floor but never fully to zero', async () => {
    const oracles: RiskOracleAggregatorSource[] = [
      { label: 'a', oracle: fixedOracle(0) },
      { label: 'b', oracle: fixedOracle(0) },
      { label: 'liar', oracle: fixedOracle(100) },
    ];
    const aggregator = new RiskOracleAggregator({
      sources: oracles,
      faultTolerance: 1,
      minWeight: 0.2,
      quorum: 3,
      timeoutMs: 1000,
    });

    for (let i = 0; i < 20; i++) {
      await aggregator.getScoreDetailed('GDEST');
    }

    expect(aggregator.getReputationSnapshot().get('liar')).toBeCloseTo(0.2, 2);
  });

  it('only updates reputation for sources that settled before the decision', async () => {
    vi.useFakeTimers();
    try {
      const aggregator = new RiskOracleAggregator({
        sources: [
          { label: 'fast-1', oracle: fixedOracle(50) },
          { label: 'fast-2', oracle: fixedOracle(50) },
          { label: 'fast-3', oracle: fixedOracle(50) },
          { label: 'hung', oracle: hangingOracle() },
        ],
        faultTolerance: 1, // quorum = 3, hung source has slack
        timeoutMs: 60_000,
      });

      const pending = aggregator.getScoreDetailed('GDEST');
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(aggregator.getReputationSnapshot().get('hung')).toBe(1); // untouched
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('weightedMedian', () => {
  it('matches the ordinary median under equal weights', () => {
    expect(weightedMedian([10, 50, 90], [1, 1, 1])).toBe(50);
  });

  it('is pulled toward whichever value carries more weight', () => {
    // A near-tie between two values: reputation weight decides the outcome.
    expect(weightedMedian([20, 80], [0.9, 0.3])).toBe(20);
    expect(weightedMedian([20, 80], [0.3, 0.9])).toBe(80);
  });
});

describe('honestOrderBounds', () => {
  it('shrinks to a subset of the true honest range as faultTolerance grows', () => {
    const values = [0, 10, 50, 90, 100];
    expect(honestOrderBounds(values, 0)).toEqual({ lo: 0, hi: 100 });
    expect(honestOrderBounds(values, 1)).toEqual({ lo: 10, hi: 90 });
    expect(honestOrderBounds(values, 2)).toEqual({ lo: 50, hi: 50 });
  });
});

describe('computeDisagreement', () => {
  it('is zero when every source agrees', () => {
    expect(computeDisagreement([50, 50, 50, 50, 50], 50, 2)).toBe(0);
  });

  it('resists a mimicry/dilution coalition: cannot score lower than the honest-only baseline', () => {
    // 3 honest sources maximally spread ({0, 50, 100}); 2 Byzantine sources
    // mimic the center (50) to try to manufacture apparent agreement.
    const honestOnly = computeDisagreement([0, 50, 100], 50, 0);
    const withMimicryCoalition = computeDisagreement([0, 50, 50, 50, 100], 50, 2);
    expect(withMimicryCoalition).toBeCloseTo(honestOnly, 10);
  });
});
