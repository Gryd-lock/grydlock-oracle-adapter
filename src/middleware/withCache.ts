import { RiskOracle } from '../RiskOracle';
import { OracleMiddleware } from '../OracleMiddleware';

export interface CacheOptions {
  /** How long a cached score stays valid, in milliseconds. */
  ttlMs: number;
  /**
   * Upper bound on cached destinations; when exceeded, the oldest-inserted
   * entry is evicted. Defaults to 1000.
   */
  maxEntries?: number;
  /** Clock returning epoch milliseconds. Injectable for tests. */
  now?: () => number;
}

interface CacheEntry {
  score: number;
  expiresAt: number;
}

/**
 * TTL-based in-memory cache middleware (issue #6), built on the shared
 * middleware abstraction (#46).
 *
 * A fresh entry short-circuits the rest of the pipeline entirely, which is
 * why the recommended composition order puts the cache outermost (below
 * logging only): a signing flow repeating a destination pays zero oracle
 * latency. Only successful results are cached — failures propagate and the
 * next call retries the pipeline. Concurrent misses for the same destination
 * are NOT collapsed into one flight; that is de-duplication (#27), a
 * separate middleware.
 */
export function withCache(options: CacheOptions): OracleMiddleware {
  const { ttlMs, maxEntries = 1000, now = Date.now } = options;
  return (next: RiskOracle): RiskOracle => {
    const entries = new Map<string, CacheEntry>();
    return {
      async getScore(destination: string): Promise<number> {
        const cached = entries.get(destination);
        if (cached && cached.expiresAt > now()) {
          return cached.score;
        }
        const score = await next.getScore(destination);
        entries.delete(destination); // re-insert so Map order tracks recency of caching
        entries.set(destination, { score, expiresAt: now() + ttlMs });
        if (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        return score;
      },
    };
  };
}
