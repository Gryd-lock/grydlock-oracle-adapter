import { RiskOracle, DetailedRiskOracle } from './RiskOracle';
import { CoalescingOracle } from './CoalescingOracle';
import { CircuitBreakerOracle, CircuitBreakerConfig } from './CircuitBreakerOracle';
import { withCache, CacheOptions, CacheNamespace } from './middleware/withCache';
import { withRateLimit, RateLimitOptions } from './middleware/withRateLimit';
import { Disposable } from './lifecycle/Disposable';
import { DurableStore } from './lifecycle/DurableStore';
import {
  RefreshLeaseCoordinator,
  RefreshLeaseCoordinatorOptions,
} from './lifecycle/RefreshLeaseCoordinator';
import { OracleLifecycleManager } from './lifecycle/OracleLifecycleManager';
import { Logger, noopLogger } from './Logger';

/** Cache-layer configuration for {@link createProductionOracleStack} — everything from {@link CacheOptions} except the pieces the factory itself wires up (`namespace`, `store`, `leaseCoordinator`). */
export type ProductionCacheOptions = Omit<CacheOptions, 'namespace' | 'store' | 'leaseCoordinator'>;

/** Rate-limit configuration for {@link createProductionOracleStack} — everything from {@link RateLimitOptions} except `store`, which the factory wires to the shared durable store. */
export type ProductionRateLimitOptions = Omit<RateLimitOptions, 'store'>;

/** {@link RefreshLeaseCoordinatorOptions} with `leaseMs` optional — the factory defaults it from `cache.ttlMs + (cache.staleMs ?? 0)` when omitted, since that's almost always the right lease length for a cache's own revalidation. */
export interface ProductionRefreshLeaseOptions extends Omit<
  RefreshLeaseCoordinatorOptions,
  'leaseMs'
> {
  /** Overrides the factory's `cache.ttlMs + (cache.staleMs ?? 0)` default. */
  leaseMs?: number;
}

/** Construction options for {@link createProductionOracleStack}. */
export interface ProductionOracleStackOptions {
  /** The raw oracle this stack ultimately calls through to (already wrapped in whatever caller-specific concerns — e.g. `withTimeout` — don't belong to this shared stack). */
  inner: RiskOracle;
  /** Trust-boundary identity for this stack's cache — see `CacheNamespace`. Required: a production stack with no namespace can't tell an incompatible restart/network-switch from a compatible one. */
  namespace: CacheNamespace;
  /** Cache-layer configuration — see {@link ProductionCacheOptions}. */
  cache: ProductionCacheOptions;
  /** Omit to run this stack with no cross-context rate limiting at all (still gets caching, coalescing, and circuit breaking). */
  rateLimit?: ProductionRateLimitOptions;
  /** Omit to run this stack with no circuit breaker. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Omit to run this stack with no request coalescing (not recommended: without it, a cache-miss stampede reaches `inner` once per concurrent caller). Defaults to `true`. */
  coalescing?: boolean;
  /** Shared durable store for cache evidence and (if `rateLimit` sets a stable `contextId`) the rate limiter's own bucket state. Omit for a purely in-memory, non-restart-safe stack. */
  store?: DurableStore;
  /** Options for the cross-context refresh-lease coordinator wired into the cache's stale-while-revalidate path. Omit to disable cross-context lease coordination (each context revalidates independently, as if `withCache` were used standalone). */
  refreshLease?: ProductionRefreshLeaseOptions;
  /** Logger for this stack's own resources (the lease coordinator; `cache`/`rateLimit` take their own `logger` inside those option bags). Defaults to the no-op logger. */
  logger?: Logger;
}

export interface ProductionOracleStack extends Disposable {
  /** The fully composed oracle: cache (outermost) -> rate limit -> circuit breaker -> coalescing -> `inner`, matching this package's documented recommended composition order (see README, "Composing cross-cutting concerns") for the layers it owns. */
  oracle: DetailedRiskOracle;
  /** Owns every resource this factory constructed (the durable-store-backed cache, the rate limiter, the lease coordinator). Call `lifecycle.init()` before serving traffic to hydrate persisted evidence, and `lifecycle.dispose()` on shutdown/suspend. */
  lifecycle: OracleLifecycleManager;
  /** Convenience: identical to `lifecycle.dispose()`. */
  dispose(): Promise<void>;
}

/**
 * Composes `withCache`, `withRateLimit`, `CircuitBreakerOracle`, and
 * `CoalescingOracle` into one restart-safe stack with a single owner for
 * their combined lifecycle (Epic requirement A: "a validated production
 * stack factory").
 *
 * ## Composition order
 *
 * `withCache` outermost (a hit skips everything below it, including the
 * rate limiter and circuit breaker — matching this package's documented
 * recommended order), then `withRateLimit`, then `CircuitBreakerOracle`,
 * then `CoalescingOracle` innermost directly around `inner` — so a
 * cache-miss stampede for the same destination coalesces into one call,
 * and only that one call's outcome can trip the breaker.
 *
 * ## Validation
 *
 * Rejects a configuration that would violate this package's own evidence
 * contracts before constructing anything: `cache.maxEvidenceAgeMs` (if set)
 * must be `>= cache.ttlMs` (also enforced by `withCache` itself; surfaced
 * here with stack-level context — see `withCache`'s own doc for why a value
 * strictly less than `ttlMs + staleMs` is the useful, not the invalid,
 * range), and a `store` with no `namespace`-carrying cache config is
 * rejected the same way `withCache` alone rejects it.
 *
 * ## Lifecycle
 *
 * Every resource this factory itself constructs — the lease coordinator (if
 * `refreshLease` is configured) — is registered on the returned
 * `lifecycle: OracleLifecycleManager`. Call `lifecycle.init()` once before
 * serving traffic (this is also when `withCache` performs its lazy
 * persistence hydration, on the first real call, so `init()` here mainly
 * exists to give a caller an explicit readiness gate rather than
 * discovering hydration failures on a live request) and `lifecycle.dispose()`
 * on shutdown or `chrome.runtime.onSuspend`.
 */
export function createProductionOracleStack(
  options: ProductionOracleStackOptions,
): ProductionOracleStack {
  const { inner, namespace, cache, rateLimit, circuitBreaker, store, refreshLease } = options;
  const coalescing = options.coalescing ?? true;
  const logger = options.logger ?? noopLogger;

  const maxEvidenceAgeMs = cache.maxEvidenceAgeMs;
  const ttlPlusStale = cache.ttlMs + (cache.staleMs ?? 0);
  if (maxEvidenceAgeMs !== undefined && maxEvidenceAgeMs < cache.ttlMs) {
    throw new RangeError(
      `createProductionOracleStack: cache.maxEvidenceAgeMs (${maxEvidenceAgeMs}) must be >= ` +
        `cache.ttlMs (${cache.ttlMs}) — see withCache's own validation for why.`,
    );
  }

  const lifecycle = new OracleLifecycleManager({ logger });

  const leaseCoordinator = refreshLease
    ? lifecycle.own(
        new RefreshLeaseCoordinator({
          leaseMs: refreshLease.leaseMs ?? (ttlPlusStale || 30_000),
          arbitrationWindowMs: refreshLease.arbitrationWindowMs,
          lockManager: refreshLease.lockManager,
          channel: refreshLease.channel,
          ownsChannel: refreshLease.ownsChannel,
          contextId: refreshLease.contextId,
          maxTrackedKeys: refreshLease.maxTrackedKeys,
          maxContextIdLength: refreshLease.maxContextIdLength,
          clockSkewToleranceMs: refreshLease.clockSkewToleranceMs,
          now: refreshLease.now,
          logger: refreshLease.logger ?? logger,
        }),
      )
    : undefined;

  let base: RiskOracle = inner;
  if (coalescing) {
    base = new CoalescingOracle(base, logger);
  }
  if (circuitBreaker) {
    base = new CircuitBreakerOracle(base, circuitBreaker);
  }

  const cachedOracle = lifecycle.own(
    withCache({
      ...cache,
      namespace,
      store,
      leaseCoordinator,
    })(rateLimit ? lifecycle.own(withRateLimit({ ...rateLimit, store })(base)) : base),
  );

  return {
    oracle: cachedOracle,
    lifecycle,
    dispose: () => lifecycle.dispose(),
  };
}
