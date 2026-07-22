import { describe, expect, it } from 'vitest';
import { withCache } from '../src/middleware/withCache';
import { DetailedRiskOracle, RiskOracle, ScoredResult } from '../src/RiskOracle';
import { ProvenanceOracle } from '../src/ProvenanceOracle';

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

/**
 * DetailedRiskOracle test double whose per-destination refetch "cost" is
 * simulated by advancing the shared manual clock synchronously during the
 * call — exactly what withCache measures via `now()` before/after — so
 * tests can assign exact, deterministic costs without real timers/delays.
 */
function configuredOracle(
  clock: ReturnType<typeof manualClock>,
  config: Record<string, { cost: number; confidence?: number; score?: number }>,
) {
  let calls = 0;
  async function getScoreDetailed(destination: string): Promise<ScoredResult> {
    calls += 1;
    const c = config[destination] ?? { cost: 0 };
    clock.advance(c.cost);
    return {
      score: c.score ?? 1,
      timestamp: clock.now(),
      source: 'ConfiguredOracle',
      cacheStatus: 'live',
      confidence: c.confidence,
    };
  }
  const oracle: DetailedRiskOracle = {
    getScore: async (d) => (await getScoreDetailed(d)).score,
    getScoreDetailed,
  };
  return { oracle, callCount: () => calls };
}

/** Flushes the microtask queue (a macrotask boundary only runs after it drains). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

describe('withCache: stale-while-revalidate', () => {
  it('reports live on first fetch, cache-fresh within ttl, cache-stale within the grace window', async () => {
    const clock = manualClock();
    const { oracle } = configuredOracle(clock, { GDEST: { cost: 0, confidence: 0.8, score: 50 } });
    const cached = withCache({ ttlMs: 1000, staleMs: 500, now: clock.now })(oracle);

    const first = await cached.getScoreDetailed('GDEST');
    expect(first.cacheStatus).toBe('live');
    expect(first.score).toBe(50);
    expect(first.confidence).toBe(0.8);

    clock.advance(500); // t=500, still within ttl
    const second = await cached.getScoreDetailed('GDEST');
    expect(second.cacheStatus).toBe('cache-fresh');
    expect(second.score).toBe(50);

    clock.advance(600); // t=1100: past ttl(1000), within ttl+staleMs(1500)
    const third = await cached.getScoreDetailed('GDEST');
    expect(third.cacheStatus).toBe('cache-stale');
    expect(third.score).toBe(50);
  });

  it('blocks on a normal fetch once the grace window fully elapses', async () => {
    const clock = manualClock();
    let score = 10;
    const oracle: DetailedRiskOracle = {
      getScore: async () => score,
      getScoreDetailed: async () => ({
        score,
        timestamp: clock.now(),
        source: 'X',
        cacheStatus: 'live',
        confidence: 1,
      }),
    };
    const cached = withCache({ ttlMs: 1000, staleMs: 500, now: clock.now })(oracle);

    expect((await cached.getScoreDetailed('GDEST')).cacheStatus).toBe('live');

    score = 99;
    clock.advance(1500); // exactly ttl+staleMs: fully expired (half-open windows)
    const result = await cached.getScoreDetailed('GDEST');
    expect(result.cacheStatus).toBe('live');
    expect(result.score).toBe(99);
  });

  it('triggers exactly one background revalidation for many concurrent callers in the stale window', async () => {
    const clock = manualClock();
    let calls = 0;
    let releaseRevalidation: (() => void) | undefined;
    const oracle: DetailedRiskOracle = {
      getScore: async (d) => (await oracle.getScoreDetailed(d)).score,
      getScoreDetailed: async () => {
        calls += 1;
        if (calls === 1) {
          return { score: 10, timestamp: clock.now(), source: 'X', cacheStatus: 'live', confidence: 1 };
        }
        // The background revalidation: held open until the test releases it.
        await new Promise<void>((resolve) => {
          releaseRevalidation = resolve;
        });
        return { score: 20, timestamp: clock.now(), source: 'X', cacheStatus: 'live', confidence: 1 };
      },
    };
    const cached = withCache({ ttlMs: 1000, staleMs: 1000, now: clock.now })(oracle);

    await cached.getScoreDetailed('GDEST'); // initial fetch
    expect(calls).toBe(1);
    clock.advance(1000); // now in the stale window

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => cached.getScoreDetailed('GDEST')),
    );

    for (const result of results) {
      expect(result.cacheStatus).toBe('cache-stale');
      expect(result.score).toBe(10); // still the old value — revalidation hasn't resolved
    }
    expect(calls).toBe(2); // exactly one background revalidation, not N

    releaseRevalidation?.();
    await flushMicrotasks();

    const afterRevalidation = await cached.getScoreDetailed('GDEST');
    expect(afterRevalidation.score).toBe(20); // revalidation landed
  });

  it('leaves the stale entry servable and produces no unhandled rejection when revalidation fails', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const clock = manualClock();
      let calls = 0;
      const oracle: DetailedRiskOracle = {
        getScore: async (d) => (await oracle.getScoreDetailed(d)).score,
        getScoreDetailed: async () => {
          calls += 1;
          if (calls === 1) {
            return { score: 10, timestamp: clock.now(), source: 'X', cacheStatus: 'live', confidence: 1 };
          }
          throw new Error('revalidation boom');
        },
      };
      const cached = withCache({ ttlMs: 1000, staleMs: 1000, now: clock.now })(oracle);

      await cached.getScoreDetailed('GDEST'); // initial fetch
      clock.advance(1000); // stale window

      const staleHit = await cached.getScoreDetailed('GDEST');
      expect(staleHit.cacheStatus).toBe('cache-stale');
      expect(staleHit.score).toBe(10);
      expect(calls).toBe(2); // the background revalidation attempt

      await flushMicrotasks(); // let the failing revalidation settle

      const stillStale = await cached.getScoreDetailed('GDEST');
      expect(stillStale.cacheStatus).toBe('cache-stale');
      expect(stillStale.score).toBe(10); // unchanged — not corrupted by the failure

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('does not import CoalescingOracle for single-flight revalidation', async () => {
    // Static check alongside the behavioral ones above: this module's own
    // doc comments discuss CoalescingOracle by name (explaining why it's
    // *not* reused here), so assert no actual import statement references
    // it, rather than a bare string match that would trip on that prose.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/middleware/withCache.ts', import.meta.url), 'utf-8'),
    );
    expect(source).not.toMatch(/^\s*import\b.*CoalescingOracle/m);
  });
});

describe('withCache: GreedyDual eviction signal isolation', () => {
  it('recency: a re-touched entry survives eviction over an equally-costed, equally-confident, untouched sibling', async () => {
    const clock = manualClock();
    // Under strictly uniform cost/confidence, the *first* eviction is an
    // unavoidable tie (see the module doc: recency only differentiates
    // entries touched at different snapshots of L, and L only moves via a
    // prior eviction). FILLER, deliberately much cheaper, bootstraps that
    // first eviction unambiguously so the GA-vs-GB comparison below is
    // clean — GA and GB share identical cost and confidence throughout.
    const { oracle, callCount } = configuredOracle(clock, {
      FILLER: { cost: 1, confidence: 1 },
      GA: { cost: 1000, confidence: 1 },
      GB: { cost: 1000, confidence: 1 },
      GC: { cost: 1000, confidence: 1 },
    });
    const cached = withCache({ ttlMs: 1_000_000, maxEntries: 2, now: clock.now })(oracle);

    await cached.getScore('FILLER'); // calls=1
    await cached.getScore('GA'); // calls=2
    await cached.getScore('GB'); // calls=3, evicts FILLER (far cheaper) — L advances
    await cached.getScore('GA'); // re-touch: GA gets fresh credit against the new L
    expect(callCount()).toBe(3); // that re-touch was a cache hit, no new call

    await cached.getScore('GC'); // calls=4, forces eviction: GB (untouched since) should go
    expect(callCount()).toBe(4);

    await cached.getScore('GA'); // still cached
    expect(callCount()).toBe(4);
    await cached.getScore('GB'); // was evicted → refetch
    expect(callCount()).toBe(5);
  });

  it('cost: with equal recency and confidence, the higher-cost entry survives eviction', async () => {
    const clock = manualClock();
    const { oracle, callCount } = configuredOracle(clock, {
      LOW: { cost: 10, confidence: 1 },
      HIGH: { cost: 1000, confidence: 1 },
      THIRD: { cost: 500, confidence: 1 },
    });
    const cached = withCache({ ttlMs: 1_000_000, maxEntries: 2, now: clock.now })(oracle);

    await cached.getScore('LOW'); // calls=1
    await cached.getScore('HIGH'); // calls=2
    await cached.getScore('THIRD'); // calls=3, forces eviction: LOW (cheapest) goes
    expect(callCount()).toBe(3);

    await cached.getScore('HIGH'); // still cached
    expect(callCount()).toBe(3);
    await cached.getScore('LOW'); // was evicted → refetch
    expect(callCount()).toBe(4);
  });

  it('confidence: with equal recency and cost, the higher-confidence entry survives eviction', async () => {
    const clock = manualClock();
    const { oracle, callCount } = configuredOracle(clock, {
      LOWCONF: { cost: 1000, confidence: 0.1 },
      HIGHCONF: { cost: 1000, confidence: 0.9 },
      THIRD: { cost: 1000, confidence: 0.5 },
    });
    const cached = withCache({ ttlMs: 1_000_000, maxEntries: 2, now: clock.now })(oracle);

    await cached.getScore('LOWCONF'); // calls=1
    await cached.getScore('HIGHCONF'); // calls=2
    await cached.getScore('THIRD'); // calls=3, forces eviction: LOWCONF (least trusted) goes
    expect(callCount()).toBe(3);

    await cached.getScore('HIGHCONF'); // still cached
    expect(callCount()).toBe(3);
    await cached.getScore('LOWCONF'); // was evicted → refetch
    expect(callCount()).toBe(4);
  });
});

describe('withCache + ProvenanceOracle', () => {
  it('reports accurate cacheStatus through ProvenanceOracle with zero changes to it', async () => {
    const clock = manualClock();
    const { oracle } = configuredOracle(clock, { GDEST: { cost: 0, confidence: 1, score: 7 } });
    const cached = withCache({ ttlMs: 1000, staleMs: 500, now: clock.now })(oracle);
    const records: unknown[] = [];
    const provenance = new ProvenanceOracle(cached, {
      logger: {
        debug: () => {},
        info: (_message, fields) => records.push(fields),
        warn: () => {},
        error: () => {},
      },
    });

    await provenance.getScore('GDEST'); // live
    await provenance.getScore('GDEST'); // cache-fresh
    clock.advance(1200); // stale window
    await provenance.getScore('GDEST'); // cache-stale

    const statuses = (records as Array<{ cacheStatus: string }>).map((r) => r.cacheStatus);
    expect(statuses).toEqual(['live', 'cache-fresh', 'cache-stale']);
  });
});

describe('withCache: fluctuating cost/confidence across an eviction/reinsertion cycle', () => {
  it('reinserts a destination cleanly after its cost/confidence profile changes and it gets evicted and refetched', async () => {
    // Motivation: h is not guaranteed monotonically non-decreasing across an
    // entry's own touches (its cost/confidence can both drop between
    // fetches), so a later, lower-h touch's heap node can be popped (and
    // evict the entry) before an earlier, higher-h node for the same entry
    // is ever reached, stranding that earlier node in the heap. Had version
    // numbers been scoped per-entry (reset on reinsertion) instead of drawn
    // from the single ever-increasing counter withCache.ts actually uses,
    // a later reinsertion could in principle collide with such a stranded
    // node's version and be evicted spuriously — that's what the counter
    // being global (proven collision-free by construction: every version
    // number issued over the cache's lifetime is unique, full stop) rules
    // out, independent of this test. This test exercises the realistic
    // shape of that scenario end-to-end and confirms the visible behavior
    // — a destination survives or refetches exactly when its current
    // cost/confidence says it should — holds up across such a cycle.
    const clock = manualClock();
    const config: Record<string, { cost: number; confidence?: number; score?: number }> = {
      X: { cost: 1000, confidence: 1 },
      FILLER: { cost: 1, confidence: 1 },
      GC: { cost: 1, confidence: 1 },
    };
    const { oracle, callCount } = configuredOracle(clock, config);
    const cached = withCache({
      ttlMs: 100,
      staleMs: 1_000_000, // long grace window: X stays stale-servable throughout
      maxEntries: 2,
      costAlpha: 1, // fully adopt each new measurement — no EMA blending, for determinism
      now: clock.now,
    })(oracle);

    await cached.getScore('X'); // h ≈ 0 + 1000*1 = 1000 (large)
    await cached.getScore('FILLER'); // h ≈ 0 + 1*1 = 1 (small); size=2, at capacity

    clock.advance(150); // push X past its fresh window into stale

    // Mutate X's profile *before* the stale hit below: the background
    // revalidation it triggers reads this config synchronously (no await
    // happens inside configuredOracle before the read), so the mutation
    // must land before that call, not after it, to actually affect it. The
    // stale hit itself still serves the *old* stored score/confidence from
    // the entry — only the revalidation's live fetch sees the new profile.
    config.X = { cost: 1, confidence: 0.01 };

    const staleHit = await cached.getScoreDetailed('X');
    expect(staleHit.cacheStatus).toBe('cache-stale');
    expect(staleHit.confidence).toBe(1); // still the old, pre-revalidation value

    // The background revalidation just kicked off reports the much lower
    // cost/confidence above, driving X's h far below its original value
    // (and below FILLER's) — while X's *original*, much-larger-h heap node
    // from the first insert is still sitting unpopped in the heap.
    await flushMicrotasks(); // let the revalidation resolve and re-touch X

    // X's new h (~0.01) is now the smallest in the cache, so inserting GC
    // evicts X via that latest touch's node — stranding the original node.
    await cached.getScore('GC');
    const callsAfterFirstEviction = callCount();

    // Re-fetch X: a genuine fresh miss, since it was just evicted. Its
    // profile is back to the original (expensive, trustworthy) one, so it
    // should be the *last* thing evicted going forward, not the first.
    config.X = { cost: 1000, confidence: 1 };
    await cached.getScore('X');
    expect(callCount()).toBe(callsAfterFirstEviction + 1); // a genuine refetch happened

    // If the reinserted X collided with the stranded stale node, the
    // eviction that just made room for it (or any eviction shortly after)
    // could spuriously remove it again immediately. Confirm it's genuinely
    // still cached: one more access must not trigger another upstream call.
    const callsAfterReinsertion = callCount();
    await cached.getScore('X');
    expect(callCount()).toBe(callsAfterReinsertion);
  });
});
