import { describe, expect, it, vi } from 'vitest';
import { withCache, CacheNamespace } from '../src/middleware/withCache';
import { RiskOracle } from '../src/RiskOracle';
import { InMemoryDurableStore } from '../src/lifecycle/DurableStore';
import { RefreshLeaseCoordinator } from '../src/lifecycle/RefreshLeaseCoordinator';

function countingOracle(score = 42): RiskOracle & { calls: number } {
  const oracle = {
    calls: 0,
    async getScore(): Promise<number> {
      oracle.calls++;
      return score;
    },
  };
  return oracle;
}

const NS: CacheNamespace = {
  network: 'testnet',
  contract: 'CONTRACT_A',
  evidenceSchemaVersion: '1',
  policyVersion: '1',
};

describe('withCache: construction validation', () => {
  it('rejects maxEvidenceAgeMs below ttlMs', () => {
    expect(() => withCache({ ttlMs: 1000, staleMs: 500, maxEvidenceAgeMs: 999 })).toThrow(
      /maxEvidenceAgeMs/,
    );
  });

  it('accepts maxEvidenceAgeMs strictly between ttlMs and ttlMs + staleMs (the useful, stale-cutting-short range)', () => {
    expect(() => withCache({ ttlMs: 1000, staleMs: 500, maxEvidenceAgeMs: 1200 })).not.toThrow();
  });

  it('accepts maxEvidenceAgeMs exactly equal to ttlMs', () => {
    expect(() => withCache({ ttlMs: 1000, staleMs: 500, maxEvidenceAgeMs: 1000 })).not.toThrow();
  });

  it('rejects a `store` supplied with no `namespace`', () => {
    expect(() => withCache({ ttlMs: 1000, store: new InMemoryDurableStore() })).toThrow(
      /namespace/,
    );
  });
});

describe('withCache: disposal', () => {
  it('dispose() is idempotent and clears in-memory state', async () => {
    let t = 0;
    const now = () => t;
    const inner = countingOracle();
    const cached = withCache({ ttlMs: 1000, now })(inner);

    await cached.getScoreDetailed('dest-1');
    expect(inner.calls).toBe(1);

    await cached.dispose();
    await cached.dispose(); // idempotent

    // After dispose, a fresh call must re-fetch (no stale in-memory entry survives).
    t += 1; // still within old ttl window, proving the entry was actually cleared, not just expired
    await expect(cached.getScore('dest-1')).rejects.toThrow(/dispose/);
  });
});

describe('withCache: namespaced persistence', () => {
  it('persists an entry and hydrates it on a fresh instance sharing the store and namespace', async () => {
    const store = new InMemoryDurableStore();
    const t = 0;
    const now = () => t;

    const inner1 = countingOracle(77);
    const cached1 = withCache({ ttlMs: 10_000, namespace: NS, store, now })(inner1);
    await cached1.getScoreDetailed('dest-1');
    expect(inner1.calls).toBe(1);

    // A brand-new instance, same store + namespace: should hydrate the
    // persisted entry rather than treating it as a cold cache.
    const inner2 = countingOracle(0);
    const cached2 = withCache({ ttlMs: 10_000, namespace: NS, store, now })(inner2);
    const result = await cached2.getScoreDetailed('dest-1');

    expect(result.cacheStatus).toBe('cache-fresh');
    expect(result.score).toBe(77);
    expect(inner2.calls).toBe(0); // hydrated, not refetched
  });

  it('does not hydrate a record persisted under a different namespace (network/contract/policy change invalidates it)', async () => {
    const store = new InMemoryDurableStore();
    const t = 0;
    const now = () => t;

    const oldOracle = countingOracle(77);
    const oldCache = withCache({ ttlMs: 10_000, namespace: NS, store, now })(oldOracle);
    await oldCache.getScoreDetailed('dest-1');

    const newNamespace: CacheNamespace = { ...NS, policyVersion: '2' }; // policy bump: trust boundary changed
    const newOracle = countingOracle(99);
    const newCache = withCache({ ttlMs: 10_000, namespace: newNamespace, store, now })(newOracle);
    const result = await newCache.getScoreDetailed('dest-1');

    expect(result.score).toBe(99); // refetched under the new oracle, old evidence unservable
    expect(newOracle.calls).toBe(1);
  });

  it('quarantines (does not hydrate) a corrupt persisted record', async () => {
    const store = new InMemoryDurableStore();
    // Write garbage directly, bypassing withCache's own writer.
    await store.setMany(new Map([[`cache::${nsKey(NS)}::dest-1`, { garbage: true }]]));

    const inner = countingOracle(55);
    const cached = withCache({ ttlMs: 10_000, namespace: NS, store })(inner);
    const result = await cached.getScoreDetailed('dest-1');

    expect(result.score).toBe(55); // treated as a cold miss, not a crash or corrupted read
    expect(inner.calls).toBe(1);
  });

  it('does not hydrate a persisted record already past maxEvidenceAgeMs at load time', async () => {
    const store = new InMemoryDurableStore();
    let t = 0;
    const now = () => t;

    const inner1 = countingOracle(1);
    const cached1 = withCache({ ttlMs: 100, maxEvidenceAgeMs: 200, namespace: NS, store, now })(
      inner1,
    );
    await cached1.getScoreDetailed('dest-1');

    t += 1_000; // well past maxEvidenceAgeMs by "restart" time

    const inner2 = countingOracle(2);
    const cached2 = withCache({ ttlMs: 100, maxEvidenceAgeMs: 200, namespace: NS, store, now })(
      inner2,
    );
    const result = await cached2.getScoreDetailed('dest-1');

    expect(result.score).toBe(2);
    expect(inner2.calls).toBe(1); // restart did not revive evidence past its absolute age cap
  });

  it('removes a persisted entry on eviction', async () => {
    const store = new InMemoryDurableStore();
    const inner = countingOracle();
    const cached = withCache({ ttlMs: 10_000, maxEntries: 1, namespace: NS, store })(inner);

    await cached.getScoreDetailed('dest-1');
    expect((await store.getAll()).size).toBe(1);

    await cached.getScoreDetailed('dest-2'); // evicts dest-1 (only 1 entry allowed)
    const remaining = [...(await store.getAll()).keys()];
    expect(remaining.some((k) => k.endsWith('::dest-1'))).toBe(false);
    expect(remaining.some((k) => k.endsWith('::dest-2'))).toBe(true);
  });
});

describe('withCache: absolute evidence-age cap overrides stale-while-revalidate', () => {
  it('serves cache-stale within staleMs but below maxEvidenceAgeMs', async () => {
    let t = 0;
    const now = () => t;
    const inner = countingOracle(10);
    const cached = withCache({ ttlMs: 100, staleMs: 1000, maxEvidenceAgeMs: 5000, now })(inner);

    await cached.getScoreDetailed('dest-1');
    t = 200; // past ttl, within staleMs and maxEvidenceAgeMs
    const result = await cached.getScoreDetailed('dest-1');
    expect(result.cacheStatus).toBe('cache-stale');
  });

  it('forces a blocking refetch once past maxEvidenceAgeMs, even while still within staleMs', async () => {
    let t = 0;
    const now = () => t;
    const inner = countingOracle(10);
    const cached = withCache({ ttlMs: 100, staleMs: 10_000, maxEvidenceAgeMs: 500, now })(inner);

    await cached.getScoreDetailed('dest-1');
    expect(inner.calls).toBe(1);

    t = 600; // past maxEvidenceAgeMs (500), still well within staleMs (10_000)
    inner.calls = 0;
    const result = await cached.getScoreDetailed('dest-1');

    expect(result.cacheStatus).toBe('live'); // not served stale
    expect(inner.calls).toBe(1); // a real blocking refetch happened
  });
});

describe('withCache: cross-context lease-gated revalidation', () => {
  it('skips its own background revalidation when the lease coordinator denies it', async () => {
    let t = 0;
    const now = () => t;
    const inner = countingOracle(10);
    const leaseCoordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
    });
    // Force every acquire() to report "someone else already owns this refresh".
    vi.spyOn(leaseCoordinator, 'acquire').mockResolvedValue(null);

    const cached = withCache({ ttlMs: 100, staleMs: 1000, now, leaseCoordinator })(inner);
    await cached.getScoreDetailed('dest-1');
    expect(inner.calls).toBe(1);

    t = 200; // stale window
    const result = await cached.getScoreDetailed('dest-1');
    expect(result.cacheStatus).toBe('cache-stale');

    await vi.waitFor(() => {
      expect(leaseCoordinator.acquire).toHaveBeenCalled();
    });
    // Revalidation never actually ran because the lease was denied.
    expect(inner.calls).toBe(1);
  });

  it('runs revalidation and releases the lease when the coordinator grants it', async () => {
    let t = 0;
    const now = () => t;
    const inner = countingOracle(10);
    const leaseCoordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
    });
    const release = vi.fn(async () => {});
    vi.spyOn(leaseCoordinator, 'acquire').mockResolvedValue({ release });

    const cached = withCache({ ttlMs: 100, staleMs: 1000, now, leaseCoordinator })(inner);
    await cached.getScoreDetailed('dest-1');

    t = 200;
    await cached.getScoreDetailed('dest-1');

    await vi.waitFor(() => {
      expect(inner.calls).toBe(2);
    });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});

function nsKey(ns: CacheNamespace): string {
  return `${ns.network}|${ns.contract}|${ns.evidenceSchemaVersion}|${ns.policyVersion}`;
}
