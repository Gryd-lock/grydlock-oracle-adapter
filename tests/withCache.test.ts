import { describe, expect, it } from 'vitest';
import { withCache } from '../src/middleware/withCache';
import { RiskOracle } from '../src/RiskOracle';

/** Oracle that counts calls and can be told what to return or throw. */
function countingOracle(scoreFor: (destination: string) => number) {
  let calls = 0;
  const oracle: RiskOracle = {
    async getScore(destination) {
      calls += 1;
      return scoreFor(destination);
    },
  };
  return { oracle, callCount: () => calls };
}

/** Manually-advanced clock so TTL expiry is deterministic. */
function manualClock(start = 0) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe('withCache', () => {
  it('serves a second call within the TTL from cache without touching the oracle', async () => {
    const { oracle, callCount } = countingOracle(() => 42);
    const clock = manualClock();
    const cached = withCache({ ttlMs: 1000, now: clock.now })(oracle);

    expect(await cached.getScore('GDEST')).toBe(42);
    clock.advance(999);
    expect(await cached.getScore('GDEST')).toBe(42);
    expect(callCount()).toBe(1);
  });

  it('refetches after the TTL expires', async () => {
    let score = 10;
    const { oracle, callCount } = countingOracle(() => score);
    const clock = manualClock();
    const cached = withCache({ ttlMs: 1000, now: clock.now })(oracle);

    expect(await cached.getScore('GDEST')).toBe(10);
    score = 80;
    clock.advance(1000);
    expect(await cached.getScore('GDEST')).toBe(80);
    expect(callCount()).toBe(2);
  });

  it('caches destinations independently', async () => {
    const { oracle, callCount } = countingOracle((d) => (d === 'GA' ? 5 : 95));
    const cached = withCache({ ttlMs: 1000 })(oracle);

    expect(await cached.getScore('GA')).toBe(5);
    expect(await cached.getScore('GB')).toBe(95);
    expect(await cached.getScore('GA')).toBe(5);
    expect(await cached.getScore('GB')).toBe(95);
    expect(callCount()).toBe(2);
  });

  it('does not cache failures', async () => {
    let failing = true;
    const oracle: RiskOracle = {
      async getScore() {
        if (failing) throw new Error('oracle unreachable');
        return 42;
      },
    };
    const cached = withCache({ ttlMs: 1000 })(oracle);

    await expect(cached.getScore('GDEST')).rejects.toThrow('oracle unreachable');
    failing = false;
    expect(await cached.getScore('GDEST')).toBe(42);
  });

  it('evicts the oldest-cached destination past maxEntries', async () => {
    const { oracle, callCount } = countingOracle(() => 1);
    const cached = withCache({ ttlMs: 10_000, maxEntries: 2 })(oracle);

    await cached.getScore('GA');
    await cached.getScore('GB');
    await cached.getScore('GC'); // evicts GA
    expect(callCount()).toBe(3);

    await cached.getScore('GB'); // still cached
    await cached.getScore('GC'); // still cached
    expect(callCount()).toBe(3);

    await cached.getScore('GA'); // was evicted → refetch
    expect(callCount()).toBe(4);
  });

  it('keeps caches independent across wrapped oracles', async () => {
    const first = countingOracle(() => 1);
    const second = countingOracle(() => 2);
    const middleware = withCache({ ttlMs: 1000 });
    const cachedFirst = middleware(first.oracle);
    const cachedSecond = middleware(second.oracle);

    expect(await cachedFirst.getScore('GDEST')).toBe(1);
    expect(await cachedSecond.getScore('GDEST')).toBe(2);
    expect(first.callCount()).toBe(1);
    expect(second.callCount()).toBe(1);
  });
});
