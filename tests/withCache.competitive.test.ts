/**
 * Competitive-ratio verification for withCache's GreedyDual-style eviction
 * (issue: cost-aware, confidence-weighted cache).
 *
 * This is a fundamentally different verification method than the
 * example-based tests in withCache.test.ts: rather than asserting a
 * specific outcome for a specific scenario, it constructs a fixed access
 * trace with known per-destination cost/confidence, computes the true
 * minimum-possible total refetch cost for that exact trace via an
 * exhaustive dynamic-programming search over eviction schedules (the
 * "optimal offline baseline" — implemented here, solely for this test, not
 * shipped in src/), and asserts the real online policy's incurred cost is
 * within a stated, justified factor of it.
 */
import { describe, expect, it } from 'vitest';
import { withCache } from '../src/middleware/withCache';
import { DetailedRiskOracle } from '../src/RiskOracle';

/**
 * Optimal offline eviction cost for a fixed trace, computed by exhaustive
 * search with memoization over (trace position, cache contents).
 *
 * Model: a request for a destination already in the cache set is free; a
 * request for one that isn't costs `cost(destination)` and, if the cache is
 * at capacity, requires evicting exactly one current member (or not caching
 * the new destination at all, which the search also considers). Filling
 * free capacity is never explored as "don't cache" since holding an
 * already-paid-for item at zero marginal cost can never make a future
 * decision worse — a standard reduction for this problem that shrinks the
 * branching factor without losing optimality.
 *
 * Confidence plays no role here deliberately: an omniscient scheduler with
 * perfect knowledge of the future trace has no need for a proxy signal like
 * confidence — it can just directly minimize real cost. Confidence is real
 * input to the *online* policy (which doesn't have future knowledge); the
 * offline baseline it's compared against only needs costs and the trace.
 */
function computeOptimalOfflineCost(
  trace: readonly string[],
  cost: (destination: string) => number,
  capacity: number,
): number {
  const memo = new Map<string, number>();

  function key(i: number, cacheSet: readonly string[]): string {
    return `${i}|${[...cacheSet].sort().join(',')}`;
  }

  function solve(i: number, cacheSet: readonly string[]): number {
    if (i === trace.length) return 0;
    const memoKey = key(i, cacheSet);
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;

    const destination = trace[i];
    let result: number;
    if (cacheSet.includes(destination)) {
      result = solve(i + 1, cacheSet);
    } else {
      const candidates: string[][] =
        cacheSet.length < capacity
          ? [[...cacheSet, destination]]
          : [
              ...cacheSet.map((victim) => [
                ...cacheSet.filter((d) => d !== victim),
                destination,
              ]),
              [...cacheSet], // don't cache the newly-fetched destination at all
            ];
      let best = Infinity;
      for (const candidate of candidates) {
        const sub = solve(i + 1, candidate);
        if (sub < best) best = sub;
      }
      result = cost(destination) + best;
    }
    memo.set(memoKey, result);
    return result;
  }

  return solve(0, []);
}

/**
 * Runs withCache's real eviction policy against a fixed trace and returns
 * the total cost actually incurred (summed over every genuine miss). Cost
 * is simulated by advancing a manual clock synchronously during the inner
 * call — exactly what withCache measures — so the online policy's own cost
 * estimates exactly match the trace's declared per-destination costs.
 * `ttlMs` is effectively infinite: only capacity-driven eviction is under
 * test here, matching the offline model, which has no notion of time-based
 * expiry at all.
 */
async function runOnlinePolicy(
  trace: readonly string[],
  cost: (destination: string) => number,
  confidence: (destination: string) => number,
  capacity: number,
): Promise<number> {
  let time = 0;
  const now = () => time;
  let totalCost = 0;

  const oracle: DetailedRiskOracle = {
    getScore: async (d) => (await oracle.getScoreDetailed(d)).score,
    getScoreDetailed: async (destination) => {
      const c = cost(destination);
      totalCost += c;
      time += c;
      return {
        score: 1,
        timestamp: now(),
        source: 'Trace',
        cacheStatus: 'live',
        confidence: confidence(destination),
      };
    },
  };

  const cached = withCache({
    ttlMs: Number.MAX_SAFE_INTEGER,
    maxEntries: capacity,
    now,
  })(oracle);

  for (const destination of trace) {
    await cached.getScoreDetailed(destination);
  }

  return totalCost;
}

/** Justified competitive bound: see the module doc's algorithm discussion
 * in withCache.ts for why GreedyDual's proven worst-case bound (k, the
 * cache capacity) is far looser than what any non-adversarial trace
 * actually produces; empirically, all three trace shapes below land well
 * inside this factor. */
const COMPETITIVE_FACTOR = 2;

interface TraceCase {
  name: string;
  trace: string[];
  cost: Record<string, number>;
  confidence: Record<string, number>;
  capacity: number;
}

function runCase(traceCase: TraceCase): Promise<{ online: number; offline: number }> {
  const costFor = (d: string) => traceCase.cost[d] ?? 1;
  const confidenceFor = (d: string) => traceCase.confidence[d] ?? 1;
  const offline = computeOptimalOfflineCost(traceCase.trace, costFor, traceCase.capacity);
  return runOnlinePolicy(traceCase.trace, costFor, confidenceFor, traceCase.capacity).then(
    (online) => ({ online, offline }),
  );
}

describe('withCache: optimal-offline-baseline sanity checks', () => {
  it('offline cost is zero cost per distinct destination when capacity covers the whole working set', () => {
    const trace = ['A', 'B', 'A', 'C', 'B', 'A', 'C', 'C', 'B'];
    const cost = { A: 10, B: 20, C: 30 };
    // capacity >= distinct destinations: every destination need only ever
    // be fetched once, then held for the rest of the trace.
    const offline = computeOptimalOfflineCost(trace, (d) => cost[d as keyof typeof cost], 3);
    expect(offline).toBe(10 + 20 + 30);
  });

  it('offline cost with capacity 0 pays for every single request', () => {
    const trace = ['A', 'A', 'A'];
    const offline = computeOptimalOfflineCost(trace, () => 5, 0);
    expect(offline).toBe(15);
  });
});

describe('withCache: competitive against the optimal offline baseline', () => {
  const cases: TraceCase[] = [
    {
      name: 'uniform cost and confidence (degenerates to LRU-like recency)',
      // A working set of 2 that fits capacity, cycling with another
      // working set of 2 — favors an eviction policy with real locality
      // awareness, which uniform-cost/confidence GreedyDual is (see the
      // withCache.ts module doc: it degenerates exactly to LRU here).
      trace: [
        'A', 'B', 'A', 'B', 'C', 'D', 'C', 'D',
        'A', 'B', 'A', 'B', 'C', 'D', 'C', 'D',
      ],
      cost: { A: 1, B: 1, C: 1, D: 1 },
      confidence: { A: 1, B: 1, C: 1, D: 1 },
      capacity: 2,
    },
    {
      name: 'skewed toward a few expensive entries',
      // Two expensive destinations accessed on almost every request,
      // interleaved with cheap one-off destinations. Cost-aware eviction
      // should keep the expensive pair resident rather than letting a
      // just-touched cheap entry bump one of them out.
      trace: [
        'EXP1', 'EXP2', 'CHEAP1',
        'EXP1', 'EXP2', 'CHEAP2',
        'EXP1', 'EXP2', 'CHEAP3',
        'EXP1', 'EXP2', 'CHEAP4',
        'EXP1', 'EXP2',
      ],
      cost: { EXP1: 200, EXP2: 200, CHEAP1: 5, CHEAP2: 5, CHEAP3: 5, CHEAP4: 5 },
      confidence: { EXP1: 1, EXP2: 1, CHEAP1: 1, CHEAP2: 1, CHEAP3: 1, CHEAP4: 1 },
      capacity: 2,
    },
    {
      name: 'skewed toward many low-confidence entries',
      // One consistently-trusted, frequently-reused destination among
      // several low-confidence ones that rotate through, each confirmed
      // wrong/stale often enough in practice to warrant low confidence.
      // Confidence-aware eviction should favor keeping the trusted one.
      trace: [
        'TRUSTED', 'LOW1', 'TRUSTED', 'LOW2', 'TRUSTED', 'LOW3',
        'TRUSTED', 'LOW1', 'TRUSTED', 'LOW2', 'TRUSTED', 'LOW3',
        'TRUSTED', 'LOW4',
      ],
      cost: { TRUSTED: 50, LOW1: 50, LOW2: 50, LOW3: 50, LOW4: 50 },
      confidence: { TRUSTED: 0.95, LOW1: 0.1, LOW2: 0.1, LOW3: 0.1, LOW4: 0.1 },
      capacity: 2,
    },
  ];

  for (const traceCase of cases) {
    it(`${traceCase.name}: online cost is within ${COMPETITIVE_FACTOR}x of optimal offline`, async () => {
      const { online, offline } = await runCase(traceCase);

      expect(offline).toBeGreaterThan(0);
      expect(online).toBeLessThanOrEqual(COMPETITIVE_FACTOR * offline);
    });
  }
});
