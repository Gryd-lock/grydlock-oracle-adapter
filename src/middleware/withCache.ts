import {
  CacheStatus,
  DetailedRiskOracle,
  OracleSource,
  RiskOracle,
  ScoredResult,
} from '../RiskOracle';
import { OracleMiddleware } from '../OracleMiddleware';
import { Logger, noopLogger } from '../Logger';

export interface CacheOptions {
  /** How long a cached score is served as fresh ('cache-fresh'), in milliseconds. */
  ttlMs: number;
  /**
   * Grace window, in milliseconds, after `ttlMs` during which a stale value
   * is still served immediately ('cache-stale') while exactly one background
   * revalidation is in flight (stale-while-revalidate, RFC 5861). Once both
   * windows have elapsed, a call blocks on a normal fetch. Defaults to `0` —
   * no stale-while-revalidate: an expired entry always blocks on refetch,
   * matching this middleware's original (pre-SWR) behavior.
   */
  staleMs?: number;
  /**
   * Upper bound on cached destinations. Eviction uses a GreedyDual-Size-
   * style cost-and-confidence-aware policy (see the module doc), not
   * insertion order. Defaults to 1000.
   */
  maxEntries?: number;
  /**
   * Smoothing factor in `(0, 1]` for the exponential moving average used to
   * estimate each destination's refetch cost from measured call latency.
   * Higher values weight the most recent fetch more heavily. Defaults to
   * `0.3`.
   */
  costAlpha?: number;
  /**
   * Confidence assumed for a destination when the wrapped oracle doesn't
   * report one — a plain `RiskOracle`, or a `DetailedRiskOracle` whose
   * result omits `confidence`. Defaults to `1` (full trust absent a signal,
   * so entries from a confidence-blind source aren't unfairly penalized in
   * eviction order relative to ones that report full confidence).
   */
  defaultConfidence?: number;
  /** Clock returning epoch milliseconds. Injectable for tests; also used to
   * measure per-destination fetch latency for the cost signal below. */
  now?: () => number;
  /** Logger for background revalidation failures. Defaults to the no-op logger. */
  logger?: Logger;
}

interface CacheEntry {
  score: number;
  source: OracleSource;
  confidence: number;
  fetchedAt: number;
  freshUntil: number;
  staleUntil: number;
  /** EMA of measured refetch latency for this destination, in ms. */
  costMs: number;
  /** Current eviction-priority value (see computeH); larger = keep longer. */
  h: number;
  /**
   * Set to a fresh value from a single ever-increasing, cache-wide counter
   * on every h change; invalidates stale heap nodes lazily (see the
   * versionCounter comment in `withCache` for why it must be global, not
   * per-entry).
   */
  version: number;
}

interface HeapNode {
  destination: string;
  h: number;
  version: number;
}

function isDetailed(oracle: RiskOracle): oracle is DetailedRiskOracle {
  return typeof (oracle as Partial<DetailedRiskOracle>).getScoreDetailed === 'function';
}

/**
 * Array-backed binary min-heap ordered by `h`, the eviction-priority field
 * defined in {@link withCache}'s module doc. Used only for GreedyDual's
 * lazy-deletion eviction bookkeeping — see `evictIfNeeded` for why a stale
 * node popped here doesn't violate the O(log n)-amortized bound.
 */
class MinHeap {
  private readonly nodes: HeapNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: HeapNode): void {
    this.nodes.push(node);
    this.siftUp(this.nodes.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.nodes.length === 0) return undefined;
    const top = this.nodes[0];
    const last = this.nodes.pop();
    if (this.nodes.length > 0 && last !== undefined) {
      this.nodes[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(start: number): void {
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.nodes[parent].h <= this.nodes[i].h) break;
      [this.nodes[parent], this.nodes[i]] = [this.nodes[i], this.nodes[parent]];
      i = parent;
    }
  }

  private siftDown(start: number): void {
    let i = start;
    const n = this.nodes.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && this.nodes[left].h < this.nodes[smallest].h) smallest = left;
      if (right < n && this.nodes[right].h < this.nodes[smallest].h) smallest = right;
      if (smallest === i) break;
      [this.nodes[smallest], this.nodes[i]] = [this.nodes[i], this.nodes[smallest]];
      i = smallest;
    }
  }
}

/**
 * Cost-aware, confidence-weighted, stale-while-revalidate cache middleware
 * (issue: replaces #6's binary-TTL, insertion-order-evicting cache).
 *
 * ## Eviction: a GreedyDual adaptation
 *
 * Plain LRU (or this middleware's original insertion-order eviction) treats
 * every entry as equally worth keeping. That's wrong once entries are
 * heterogeneous: a destination that was expensive to fetch and came back
 * with high confidence is more valuable to keep cached than one that was
 * cheap and low-confidence, independent of which was touched more recently.
 *
 * This adapts GreedyDual (Cao & Irani, "Cost-Aware WWW Proxy Caching
 * Algorithms", 1997) — the degenerate, uniform-size member of the
 * GreedyDual-Size family, since every cache entry here is one score (no
 * variable object size to weight by). Each entry carries a priority value:
 *
 * ```
 * h(entry) = L + costMs(entry) * confidence(entry)
 * ```
 *
 * `costMs` is an EMA of measured latency refetching that destination from
 * the wrapped oracle (a genuinely expensive destination gets more credit).
 * `confidence` in `[0, 1]` scales that credit down for entries the source
 * itself trusts less (a confidence of 0 collapses an entry's credit to
 * `L` — the wrapped oracle vouching for the value at all is what earns it
 * any protection). `L` is a monotonically non-decreasing "clock": on every
 * access (hit or fresh fetch), `h` is recomputed against the *current* `L`,
 * so a recently-touched entry is pushed ahead of `L` by its own credit —
 * this is what gives GreedyDual its recency behavior without a separate
 * recency term. On eviction, the entry with the *smallest* `h` is evicted,
 * and `L` is advanced to that evicted value — so the "cost floor" every
 * surviving entry must clear only rises when something is actually evicted,
 * never on its own. With uniform cost/confidence across all entries this
 * degenerates to exactly the recency ordering of LRU; GreedyDual (unweighted
 * by size) is proven k-competitive against the optimal offline eviction
 * schedule, where k is cache capacity — see
 * tests/withCache.competitive.test.ts for an empirical demonstration on
 * fixed traces against a DP-computed optimal baseline, which lands far
 * inside that bound for realistic (non-adversarial) access patterns.
 *
 * Eviction bookkeeping uses a binary min-heap over `h`, keyed with lazy
 * deletion: every access pushes a fresh node and bumps the entry's
 * `version`; a popped node is discarded (not evicted) if its version no
 * longer matches the entry's current one. Each node is pushed once and
 * popped at most once over its lifetime, so touch/evict is O(log n)
 * *amortized* — the occasional run of discarded stale pops is paid for by
 * the touches that pushed them, not charged again to later operations.
 * Because nothing ever pops nodes for entries that are merely *not*
 * evicted, the heap can accumulate more nodes than there are live entries
 * over a long-running cache; once it exceeds `2 * entries.size`, it's
 * rebuilt from scratch (one node per live entry) — an O(n) rebuild
 * triggered only once per Θ(n) touches, which preserves the amortized
 * O(log n) bound while keeping total memory bounded by `maxEntries`
 * instead of growing without limit.
 *
 * ## Stale-while-revalidate
 *
 * Once an entry is past `ttlMs` but still within `ttlMs + staleMs`, calls
 * are served the stale value immediately ('cache-stale') while at most one
 * background revalidation is in flight for that destination — tracked with
 * this middleware's own `Set<string>`, entirely independent of
 * `CoalescingOracle` (a separate concern, not imported or duplicated here).
 * Because the stale-serving branch never awaits anything before deciding
 * whether to start a revalidation, N callers issued in the same
 * synchronous burst are guaranteed to see a consistent view of that
 * tracking set — JavaScript never interleaves two calls to the same
 * function without an intervening `await` — so exactly one revalidation
 * starts regardless of how many callers arrive concurrently. A failed
 * revalidation is logged and otherwise ignored: the still-valid stale entry
 * is left untouched (not evicted, not corrupted), and the rejection is
 * caught here so it can never surface as unhandled.
 *
 * If the entry is evicted by capacity pressure while a revalidation for it
 * is in flight, the revalidation's result is dropped on arrival rather than
 * resurrecting the entry — the cache already decided that destination
 * wasn't worth keeping.
 *
 * The returned oracle implements `DetailedRiskOracle`: `cacheStatus` is
 * `'live'` on a fresh fetch, `'cache-fresh'`/`'cache-stale'` on a hit in
 * either window. Composing `ProvenanceOracle(withCache(...)(inner))`
 * reports this accurately with no changes to `ProvenanceOracle.ts` — it
 * already prefers a wrapped `DetailedRiskOracle`'s own reported status.
 */
export function withCache(options: CacheOptions): OracleMiddleware {
  const {
    ttlMs,
    staleMs = 0,
    maxEntries = 1000,
    costAlpha = 0.3,
    defaultConfidence = 1,
    now = Date.now,
    logger = noopLogger,
  } = options;

  const HEAP_COMPACTION_RATIO = 2;

  return (next: RiskOracle): DetailedRiskOracle => {
    const entries = new Map<string, CacheEntry>();
    let heap = new MinHeap();
    const revalidating = new Set<string>();
    let clockL = 0;
    // Monotonically increasing, shared across every destination and never
    // reset — including across an eviction-then-reinsertion cycle for the
    // same destination. `h` is not guaranteed monotonically non-decreasing
    // across an entry's own touches (costMs/confidence can both drop), so a
    // later touch's node can legitimately pop before an earlier one,
    // stranding the earlier node in the heap. A per-entry counter that
    // resets to 0/1 on reinsertion could then collide with that stranded
    // node's version and be mistaken for it. A single ever-increasing
    // counter makes every version number ever issued unique for the
    // lifetime of this cache instance, which rules that out entirely.
    let versionCounter = 0;

    function computeH(entry: Pick<CacheEntry, 'costMs' | 'confidence'>): number {
      return clockL + entry.costMs * entry.confidence;
    }

    function touch(destination: string, entry: CacheEntry): void {
      entry.h = computeH(entry);
      entry.version = ++versionCounter;
      heap.push({ destination, h: entry.h, version: entry.version });
      if (heap.size > HEAP_COMPACTION_RATIO * Math.max(entries.size, 1)) {
        compactHeap();
      }
    }

    function compactHeap(): void {
      const rebuilt = new MinHeap();
      for (const [destination, entry] of entries) {
        rebuilt.push({ destination, h: entry.h, version: entry.version });
      }
      heap = rebuilt;
    }

    function evictIfNeeded(): void {
      while (entries.size > maxEntries) {
        let node = heap.pop();
        while (node !== undefined) {
          const current = entries.get(node.destination);
          if (current !== undefined && current.version === node.version) break;
          node = heap.pop();
        }
        if (node === undefined) break; // heap exhausted; nothing left to evict
        entries.delete(node.destination);
        clockL = node.h;
      }
    }

    async function fetchFromInner(
      destination: string,
    ): Promise<{ score: number; source: OracleSource; confidence: number; costMs: number }> {
      const start = now();
      let score: number;
      let source: OracleSource;
      let confidence: number;
      if (isDetailed(next)) {
        const detailed = await next.getScoreDetailed(destination);
        score = detailed.score;
        source = detailed.source;
        confidence = detailed.confidence ?? defaultConfidence;
      } else {
        score = await next.getScore(destination);
        source = next.constructor.name;
        confidence = defaultConfidence;
      }
      const costMs = Math.max(0, now() - start);
      return { score, source, confidence, costMs };
    }

    function blendCost(previous: number | undefined, measured: number): number {
      return previous === undefined ? measured : costAlpha * measured + (1 - costAlpha) * previous;
    }

    async function freshFetch(destination: string): Promise<ScoredResult> {
      const existing = entries.get(destination);
      const fetched = await fetchFromInner(destination);
      const fetchedAt = now();
      const entry: CacheEntry = {
        score: fetched.score,
        source: fetched.source,
        confidence: fetched.confidence,
        fetchedAt,
        freshUntil: fetchedAt + ttlMs,
        staleUntil: fetchedAt + ttlMs + staleMs,
        costMs: blendCost(existing?.costMs, fetched.costMs),
        h: 0, // placeholder; touch() below assigns the real value
        version: 0, // placeholder; touch() below assigns a fresh global version
      };
      entries.set(destination, entry);
      touch(destination, entry);
      evictIfNeeded();
      return serve(entry, 'live');
    }

    function revalidate(destination: string): Promise<void> {
      return fetchFromInner(destination)
        .then((fetched) => {
          const existing = entries.get(destination);
          if (existing === undefined) {
            return; // evicted while in flight; don't resurrect it
          }
          const fetchedAt = now();
          existing.score = fetched.score;
          existing.source = fetched.source;
          existing.confidence = fetched.confidence;
          existing.fetchedAt = fetchedAt;
          existing.freshUntil = fetchedAt + ttlMs;
          existing.staleUntil = fetchedAt + ttlMs + staleMs;
          existing.costMs = blendCost(existing.costMs, fetched.costMs);
          touch(destination, existing);
          // A successful revalidation updates an existing key in place; it
          // never grows entries.size, so no eviction check is needed here.
        })
        .catch((err: unknown) => {
          logger.warn('withCache.revalidationFailed', { destination, err });
        });
    }

    function serve(entry: CacheEntry, cacheStatus: CacheStatus): ScoredResult {
      return {
        score: entry.score,
        timestamp: entry.fetchedAt,
        source: entry.source,
        cacheStatus,
        confidence: entry.confidence,
      };
    }

    async function getScoreDetailedImpl(destination: string): Promise<ScoredResult> {
      const entry = entries.get(destination);
      const t = now();

      if (entry !== undefined && t < entry.freshUntil) {
        touch(destination, entry);
        return serve(entry, 'cache-fresh');
      }

      if (entry !== undefined && t < entry.staleUntil) {
        touch(destination, entry);
        if (!revalidating.has(destination)) {
          revalidating.add(destination);
          void revalidate(destination).finally(() => revalidating.delete(destination));
        }
        return serve(entry, 'cache-stale');
      }

      // Fully expired (or never cached): concurrent cold misses for the
      // same destination are NOT single-flighted here — that's
      // CoalescingOracle's job (a separate, composable middleware), exactly
      // as this module's original doc noted before this rewrite. Only the
      // stale-while-revalidate background fetch above gets this module's
      // own single-flight guarantee.
      return freshFetch(destination);
    }

    return {
      async getScore(destination: string): Promise<number> {
        const result = await getScoreDetailedImpl(destination);
        return result.score;
      },
      getScoreDetailed: getScoreDetailedImpl,
    };
  };
}
