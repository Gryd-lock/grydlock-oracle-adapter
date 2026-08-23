import { describe, expect, it } from 'vitest';
import { CacheControlUnsupportedError } from '../src/OracleError';
import {
  RequestContext,
  createRequestContext,
  deriveRequestContext,
  isExpired,
  remainingBudgetMs,
  requireCacheControlSupport,
} from '../src/RequestContext';

describe('createRequestContext', () => {
  it('has no deadline (Infinity) when neither deadlineAt nor timeoutMs is given', () => {
    const context = createRequestContext();
    expect(context.deadlineAt).toBe(Number.POSITIVE_INFINITY);
  });

  it('converts a relative timeoutMs to an absolute deadlineAt at creation time', () => {
    const context = createRequestContext({ timeoutMs: 500, now: () => 1_000 });
    expect(context.deadlineAt).toBe(1_500);
  });

  it('prefers an explicit deadlineAt over timeoutMs', () => {
    const context = createRequestContext({ deadlineAt: 9_999, timeoutMs: 500, now: () => 1_000 });
    expect(context.deadlineAt).toBe(9_999);
  });

  it('defaults cache control to no bypass/no revalidate', () => {
    const context = createRequestContext();
    expect(context.cache).toEqual({ bypassCache: false, revalidate: false });
  });

  it('honors explicit cache-control intent', () => {
    const context = createRequestContext({ bypassCache: true, revalidate: true });
    expect(context.cache).toEqual({ bypassCache: true, revalidate: true });
  });

  it('generates a correlationId when none is supplied, distinct across calls', () => {
    const a = createRequestContext();
    const b = createRequestContext();
    expect(a.correlationId).toBeTruthy();
    expect(b.correlationId).toBeTruthy();
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it('uses a caller-supplied correlationId unchanged', () => {
    const context = createRequestContext({ correlationId: 'req-abc' });
    expect(context.correlationId).toBe('req-abc');
  });

  it('carries the supplied AbortSignal', () => {
    const controller = new AbortController();
    const context = createRequestContext({ signal: controller.signal });
    expect(context.signal).toBe(controller.signal);
  });
});

describe('remainingBudgetMs / isExpired', () => {
  it('computes remaining budget against the absolute deadline at read time', () => {
    const context = createRequestContext({ deadlineAt: 1_000 });
    expect(remainingBudgetMs(context, () => 400)).toBe(600);
    expect(remainingBudgetMs(context, () => 999)).toBe(1);
    expect(remainingBudgetMs(context, () => 1_000)).toBe(0);
  });

  it('never returns a negative remaining budget', () => {
    const context = createRequestContext({ deadlineAt: 1_000 });
    expect(remainingBudgetMs(context, () => 5_000)).toBe(0);
  });

  it('returns Infinity remaining budget for a deadline-less context', () => {
    const context = createRequestContext();
    expect(remainingBudgetMs(context, () => Date.now())).toBe(Number.POSITIVE_INFINITY);
  });

  it('isExpired is false before the deadline and true at/after it', () => {
    const context = createRequestContext({ deadlineAt: 1_000 });
    expect(isExpired(context, () => 999)).toBe(false);
    expect(isExpired(context, () => 1_000)).toBe(true);
    expect(isExpired(context, () => 1_001)).toBe(true);
  });

  it('a deadline-less context is never expired', () => {
    const context = createRequestContext();
    expect(isExpired(context, () => Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('deriveRequestContext', () => {
  it('shares the parent deadlineAt and correlationId', () => {
    const parent = createRequestContext({ deadlineAt: 1_000, correlationId: 'req-1' });
    const child = deriveRequestContext(parent);
    expect(child.deadlineAt).toBe(1_000);
    expect(child.correlationId).toBe('req-1');
  });

  it('inherits the parent signal by default, but accepts an override', () => {
    const parentController = new AbortController();
    const parent = createRequestContext({ signal: parentController.signal });
    const inherited = deriveRequestContext(parent);
    expect(inherited.signal).toBe(parentController.signal);

    const childController = new AbortController();
    const overridden = deriveRequestContext(parent, { signal: childController.signal });
    expect(overridden.signal).toBe(childController.signal);
  });

  it('inherits cache control by default, but accepts per-call overrides', () => {
    const parent = createRequestContext({ bypassCache: true });
    const inherited = deriveRequestContext(parent);
    expect(inherited.cache).toEqual({ bypassCache: true, revalidate: false });

    const overridden = deriveRequestContext(parent, { revalidate: true });
    expect(overridden.cache).toEqual({ bypassCache: true, revalidate: true });
  });
});

describe('requireCacheControlSupport', () => {
  it('passes silently when no special cache-control intent was requested', () => {
    const context = createRequestContext();
    expect(() =>
      requireCacheControlSupport(context, { supportsBypass: false, supportsRevalidate: false }),
    ).not.toThrow();
  });

  it('throws CacheControlUnsupportedError for bypassCache when unsupported, never silently ignoring it', () => {
    const context = createRequestContext({ bypassCache: true });
    expect(() =>
      requireCacheControlSupport(context, { supportsBypass: false, supportsRevalidate: true }),
    ).toThrow(CacheControlUnsupportedError);
  });

  it('throws CacheControlUnsupportedError for revalidate when unsupported', () => {
    const context = createRequestContext({ revalidate: true });
    expect(() =>
      requireCacheControlSupport(context, { supportsBypass: true, supportsRevalidate: false }),
    ).toThrow(CacheControlUnsupportedError);
  });

  it('passes when the requested intent is supported', () => {
    const context = createRequestContext({ bypassCache: true, revalidate: true });
    expect(() =>
      requireCacheControlSupport(context, { supportsBypass: true, supportsRevalidate: true }),
    ).not.toThrow();
  });
});

/**
 * Small in-test harness simulating a retry/fallback chain — deliberately
 * NOT wired into the real `FallbackOracle` (that migration is deferred
 * follow-up work; see the PR description). Each "attempt" costs a fixed
 * amount of simulated time; the loop consults `remainingBudgetMs` against
 * the *same* `RequestContext` before every attempt.
 */
function simulateAttempts(
  context: RequestContext,
  attemptCostMs: number,
  clock: { now: number },
  maxAttempts = 100,
): number {
  let attempts = 0;
  while (attempts < maxAttempts && remainingBudgetMs(context, () => clock.now) > 0) {
    attempts += 1;
    clock.now += attemptCostMs;
  }
  return attempts;
}

describe('a single absolute deadline composes across a simulated retry/fallback chain', () => {
  it('bounds total attempts by ONE shared budget, not a budget reset per attempt', () => {
    const clock = { now: 0 };
    const context = createRequestContext({ timeoutMs: 100, now: () => clock.now });

    const attempts = simulateAttempts(context, 30, clock);

    // 100ms budget / 30ms per attempt: the loop must stop once the shared
    // deadline is exhausted, not run away.
    expect(attempts).toBe(4);
    expect(clock.now).toBe(120);
  });

  it('contrasts with the bug this composition guarantee prevents: minting a fresh relative timeout per attempt never converges on the same total budget', () => {
    const clock = { now: 0 };
    const ATTEMPT_COST_MS = 30;
    const PER_ATTEMPT_BUDGET_MS = 100;
    let attempts = 0;

    // The wrong way: each "attempt" constructs its own context from a
    // relative timeoutMs, re-arming a fresh window instead of threading
    // one absolute deadline through. Every single attempt sees a full,
    // unconsumed budget again.
    while (attempts < 4) {
      const perAttemptContext = createRequestContext({
        timeoutMs: PER_ATTEMPT_BUDGET_MS,
        now: () => clock.now,
      });
      expect(remainingBudgetMs(perAttemptContext, () => clock.now)).toBe(PER_ATTEMPT_BUDGET_MS);
      attempts += 1;
      clock.now += ATTEMPT_COST_MS;
    }

    // After 4 attempts (120ms of real elapsed time), a caller relying on
    // the shared-deadline contract would have stopped at attempt 4 with 0
    // budget remaining (previous test). Here, each attempt still reports a
    // full fresh 100ms budget — proving the bug this module's "absolute,
    // not relative" deadline exists to prevent.
    const finalPerAttemptContext = createRequestContext({
      timeoutMs: PER_ATTEMPT_BUDGET_MS,
      now: () => clock.now,
    });
    expect(remainingBudgetMs(finalPerAttemptContext, () => clock.now)).toBe(PER_ATTEMPT_BUDGET_MS);
  });
});

describe('cancellation via the shared AbortSignal contract', () => {
  it('stops further simulated work once the signal fires', () => {
    const controller = new AbortController();
    const context = createRequestContext({ signal: controller.signal });

    let workDone = 0;
    function doWorkIfNotCancelled(): boolean {
      if (context.signal?.aborted) return false;
      workDone += 1;
      return true;
    }

    expect(doWorkIfNotCancelled()).toBe(true);
    expect(doWorkIfNotCancelled()).toBe(true);
    controller.abort();
    expect(doWorkIfNotCancelled()).toBe(false);
    expect(doWorkIfNotCancelled()).toBe(false);

    expect(workDone).toBe(2);
  });

  it('a derived child context observes the same abort as its parent', () => {
    const controller = new AbortController();
    const parent = createRequestContext({ signal: controller.signal });
    const child = deriveRequestContext(parent);

    expect(child.signal?.aborted).toBe(false);
    controller.abort();
    expect(child.signal?.aborted).toBe(true);
  });
});
