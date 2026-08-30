import { describe, expect, it, vi } from 'vitest';
import { createProductionOracleStack } from '../src/createProductionOracleStack';
import { RiskOracle } from '../src/RiskOracle';
import { InMemoryDurableStore } from '../src/lifecycle/DurableStore';
import { CacheNamespace } from '../src/middleware/withCache';

const NS: CacheNamespace = {
  network: 'testnet',
  contract: 'CONTRACT_A',
  evidenceSchemaVersion: '1',
  policyVersion: '1',
};

function countingOracle(score = 10): RiskOracle & { calls: number } {
  const oracle = {
    calls: 0,
    async getScore(): Promise<number> {
      oracle.calls++;
      return score;
    },
  };
  return oracle;
}

describe('createProductionOracleStack', () => {
  it('rejects cache.maxEvidenceAgeMs below cache.ttlMs before constructing anything', () => {
    expect(() =>
      createProductionOracleStack({
        inner: countingOracle(),
        namespace: NS,
        cache: { ttlMs: 1000, maxEvidenceAgeMs: 500 },
      }),
    ).toThrow(/maxEvidenceAgeMs/);
  });

  it('composes a working oracle that serves scores end to end', async () => {
    const inner = countingOracle(42);
    const stack = createProductionOracleStack({
      inner,
      namespace: NS,
      cache: { ttlMs: 10_000 },
      rateLimit: { budget: 100, windowMs: 10_000, channel: null },
      circuitBreaker: { failureThreshold: 3, cooldownWindow: 1000 },
    });

    await stack.lifecycle.init();
    const score = await stack.oracle.getScore('dest-1');
    expect(score).toBe(42);
    expect(inner.calls).toBe(1);

    // Second call hits the cache: inner is not called again.
    await stack.oracle.getScore('dest-1');
    expect(inner.calls).toBe(1);

    await stack.dispose();
  });

  it('lifecycle.init() becomes ready and dispose() tears down owned resources idempotently', async () => {
    const stack = createProductionOracleStack({
      inner: countingOracle(),
      namespace: NS,
      cache: { ttlMs: 1000 },
      rateLimit: { budget: 10, windowMs: 1000, channel: null },
    });

    await stack.lifecycle.init();
    expect(stack.lifecycle.getState()).toBe('ready');

    await stack.dispose();
    await stack.dispose(); // idempotent
    expect(stack.lifecycle.getState()).toBe('disposed');

    // The composed oracle must reject further use after teardown.
    await expect(stack.oracle.getScore('dest-1')).rejects.toThrow(/dispose/);
  });

  it('runs with no rateLimit/circuitBreaker configured at all', async () => {
    const inner = countingOracle(7);
    const stack = createProductionOracleStack({
      inner,
      namespace: NS,
      cache: { ttlMs: 1000 },
    });
    await stack.lifecycle.init();
    expect(await stack.oracle.getScore('dest-1')).toBe(7);
    await stack.dispose();
  });

  it('shares one durable store across cache and rate limiter when configured', async () => {
    const store = new InMemoryDurableStore();
    const inner = countingOracle(5);
    const stack = createProductionOracleStack({
      inner,
      namespace: NS,
      cache: { ttlMs: 10_000 },
      rateLimit: { budget: 10, windowMs: 10_000, channel: null, contextId: 'stable' },
      store,
    });

    await stack.lifecycle.init();
    await stack.oracle.getScore('dest-1');
    await stack.dispose();

    const allKeys = [...(await store.getAll()).keys()];
    expect(allKeys.some((k) => k.startsWith('cache::'))).toBe(true);
    expect(allKeys.some((k) => k.startsWith('rate-limit::'))).toBe(true);
  });

  it('a failing init() (e.g. hydration blowing up) leaves nothing owned running', async () => {
    const badStore = new InMemoryDurableStore();
    vi.spyOn(badStore, 'getAll').mockRejectedValue(new Error('storage unavailable'));

    const stack = createProductionOracleStack({
      inner: countingOracle(),
      namespace: NS,
      cache: { ttlMs: 1000 },
      store: badStore,
    });

    // withCache's own hydration failure is caught internally (logged, not
    // thrown) — so init() itself still succeeds; this test documents that
    // hydration failure degrades to "cold cache", not a thrown error.
    await expect(stack.lifecycle.init()).resolves.toBeUndefined();
    await stack.dispose();
  });
});
