import { CacheControlUnsupportedError } from './OracleError';

/**
 * A composable request context threaded through a call and everything it
 * spawns (retries, fallback tiers, aggregation fan-out), unifying:
 *
 * - A single **absolute** deadline (`deadlineAt`, epoch ms) rather than a
 *   relative timeout. A relative `timeoutMs` reset at every layer silently
 *   multiplies the caller's actual budget (a 1s timeout wrapped by a
 *   3-tier fallback, each re-arming its own 1s timer, can take 3s end to
 *   end). An absolute deadline composes correctly instead: every layer
 *   computes its own remaining budget against the *same* instant via
 *   {@link remainingBudgetMs}, so nested calls shrink the effective budget
 *   rather than resetting it.
 * - Cancellation, via the same `AbortSignal` contract `CancellableRiskOracle`
 *   already establishes (see `CancellableRiskOracle.ts`) — this module
 *   doesn't invent a second cancellation mechanism, it just gives that
 *   contract a home alongside the deadline it's meant to compose with.
 * - A stable request identity (`correlationId`) — *not* the destination —
 *   so a logging/provenance sink can correlate every attempt (retry,
 *   fallback tier, aggregation source) belonging to one logical caller
 *   request without using the destination as the join key (see
 *   `RiskDecisionProvenance.ts`, which deliberately keeps its correlation
 *   id independent of the destination for the same reason).
 * - Explicit cache-control intent (`bypassCache` / `revalidate`) that a
 *   callee must either honor or explicitly reject via
 *   {@link CacheControlUnsupportedError} — never silently ignore. This
 *   mirrors `RiskOracle.getScore`'s existing `options.bypassCache`, but as
 *   a request-scoped intent that travels with everything the request
 *   spawns instead of a single call's local option.
 *
 * This is additive: nothing in the existing `RiskOracle`/middleware stack
 * requires or consumes a `RequestContext` today. It exists so new,
 * `RiskDecision`-aware call sites have one consistent way to carry this
 * plumbing instead of each inventing its own ad hoc options bag.
 */
export interface RequestContext {
  /** Absolute epoch-ms instant by which this request (and everything it spawns) must complete. `Number.POSITIVE_INFINITY` means "no deadline." */
  readonly deadlineAt: number;
  /** Stable identity for this logical request, shared by every retry/fallback/aggregation attempt it spawns. Never the destination. */
  readonly correlationId: string;
  /** Cancellation signal, per the `CancellableRiskOracle` contract. Optional: a context with no signal is simply never externally cancelled. */
  readonly signal?: AbortSignal;
  /** Cache-control intent that must be honored or explicitly rejected. */
  readonly cache: CacheControl;
}

/** Cache-control intent carried by a {@link RequestContext}. */
export interface CacheControl {
  /** Skip any cache read for this request; a cache-aware callee that cannot skip its cache must reject via {@link CacheControlUnsupportedError} rather than silently serving a cached value. */
  readonly bypassCache: boolean;
  /** Treat any cached value as needing revalidation before use, even if it is still within its fresh window. */
  readonly revalidate: boolean;
}

/** Cache-control intent equivalent to not requesting anything special. */
export const DEFAULT_CACHE_CONTROL: CacheControl = Object.freeze({
  bypassCache: false,
  revalidate: false,
});

function randomCorrelationId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID (older runtimes),
  // matching the same fallback `middleware/withRateLimit.ts` uses for its
  // own request-scoped id.
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Construction options for {@link createRequestContext}. */
export interface CreateRequestContextOptions {
  /** Absolute epoch-ms deadline. Takes precedence over `timeoutMs` if both are given. */
  deadlineAt?: number;
  /**
   * Convenience: a relative budget in milliseconds, converted to an
   * absolute `deadlineAt` once, at creation time, via `now()`. Prefer this
   * for a brand-new top-level request; once a context exists, thread it
   * through via {@link remainingBudgetMs} rather than constructing a fresh
   * one, or the composition guarantee above is lost.
   */
  timeoutMs?: number;
  /** Stable request identity. Defaults to a freshly generated id. */
  correlationId?: string;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Skip any cache read. Defaults to `false`. */
  bypassCache?: boolean;
  /** Require revalidation of any cached value. Defaults to `false`. */
  revalidate?: boolean;
  /** Clock returning epoch milliseconds. Injectable for tests. */
  now?: () => number;
}

/**
 * Builds a {@link RequestContext}. With neither `deadlineAt` nor
 * `timeoutMs`, the context has no deadline (`deadlineAt: Infinity`) — an
 * explicit choice, not an accidentally-unbounded default: a caller that
 * wants a budget has to say so, exactly like a caller that wants
 * cache-control intent has to say so.
 */
export function createRequestContext(options: CreateRequestContextOptions = {}): RequestContext {
  const now = options.now ?? Date.now;
  const deadlineAt =
    options.deadlineAt ??
    (options.timeoutMs !== undefined ? now() + options.timeoutMs : Number.POSITIVE_INFINITY);

  return Object.freeze({
    deadlineAt,
    correlationId: options.correlationId ?? randomCorrelationId(),
    signal: options.signal,
    cache: Object.freeze({
      bypassCache: options.bypassCache ?? false,
      revalidate: options.revalidate ?? false,
    }),
  });
}

/**
 * The remaining budget, in milliseconds, between `now()` and
 * `context.deadlineAt` — computed fresh at read time against the
 * *original* absolute deadline, never against a locally-restarted relative
 * timer. Nested/retried calls should call this again immediately before
 * each attempt rather than caching the result, so the budget actually
 * shrinks across attempts instead of being handed the same window
 * repeatedly.
 *
 * Never negative: a deadline already in the past yields `0`, not a
 * negative number a naive `setTimeout(fn, remaining)` caller might
 * misinterpret as "no timeout."
 */
export function remainingBudgetMs(
  context: Pick<RequestContext, 'deadlineAt'>,
  now: () => number = Date.now,
): number {
  if (!Number.isFinite(context.deadlineAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, context.deadlineAt - now());
}

/** True when `context`'s deadline has already passed as of `now()`. */
export function isExpired(
  context: Pick<RequestContext, 'deadlineAt'>,
  now: () => number = Date.now,
): boolean {
  return Number.isFinite(context.deadlineAt) && now() >= context.deadlineAt;
}

/**
 * Derives a child context that shares the parent's `deadlineAt` and
 * `correlationId` (the whole point of an absolute deadline and a stable
 * request identity is that nested calls reuse them, not mint their own),
 * while allowing overrides for the rest — most commonly a narrower
 * `AbortSignal` for one sub-call, or cache-control intent scoped to just
 * that sub-call.
 */
export function deriveRequestContext(
  parent: RequestContext,
  overrides: Partial<Pick<RequestContext, 'signal'>> & {
    bypassCache?: boolean;
    revalidate?: boolean;
  } = {},
): RequestContext {
  return Object.freeze({
    deadlineAt: parent.deadlineAt,
    correlationId: parent.correlationId,
    signal: overrides.signal ?? parent.signal,
    cache: Object.freeze({
      bypassCache: overrides.bypassCache ?? parent.cache.bypassCache,
      revalidate: overrides.revalidate ?? parent.cache.revalidate,
    }),
  });
}

/** Which cache-control capabilities a callee supports, for {@link requireCacheControlSupport}. */
export interface CacheControlCapabilities {
  /** Whether this callee can skip a cache read entirely when asked. */
  supportsBypass: boolean;
  /** Whether this callee can force revalidation of a cached value when asked. */
  supportsRevalidate: boolean;
}

/**
 * Asserts that `context`'s cache-control intent is honorable by a callee
 * with the given `capabilities`, throwing {@link CacheControlUnsupportedError}
 * rather than letting a callee silently ignore `bypassCache`/`revalidate`
 * it cannot actually implement. A cache-unaware callee (no cache at all)
 * trivially honors both, since there is nothing to bypass or revalidate.
 */
export function requireCacheControlSupport(
  context: Pick<RequestContext, 'cache'>,
  capabilities: CacheControlCapabilities,
): void {
  if (context.cache.bypassCache && !capabilities.supportsBypass) {
    throw new CacheControlUnsupportedError({ control: 'bypassCache' });
  }
  if (context.cache.revalidate && !capabilities.supportsRevalidate) {
    throw new CacheControlUnsupportedError({ control: 'revalidate' });
  }
}
