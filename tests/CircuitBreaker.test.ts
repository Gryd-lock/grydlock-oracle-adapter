import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CircuitBreakerOracle,
  CircuitBreakerState,
  CircuitBreakerConfig,
} from '../src/CircuitBreakerOracle';
import { RiskOracle } from '../src/RiskOracle';
import { CancellableRiskOracle } from '../src/CancellableRiskOracle';
import { OracleCancelledError } from '../src/OracleError';

class MockOracle implements RiskOracle {
  getScore = vi.fn<[string], Promise<number>>();
}

/**
 * Cancellable test double. The first call after construction (or after the
 * last `resolve()`) stays pending until `resolve()` is called; once called,
 * every call made from then on (including ones not yet issued at the time
 * of the call) auto-resolves to that same value immediately, since exactly
 * when a caller re-issues its own call after a shared wait is an
 * implementation-timing detail these tests should not depend on.
 */
class ControlledCancellableOracle implements CancellableRiskOracle {
  public callCount = 0;
  public lastSignal: AbortSignal | undefined;
  private resolveFn?: (v: number) => void;
  private autoResolveValue: number | undefined;

  /** Plain (non-cancellable) path, used only to trip the breaker to OPEN in setup. */
  getScore = vi.fn<[string], Promise<number>>();

  getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
    this.callCount++;
    this.lastSignal = signal;
    if (this.autoResolveValue !== undefined) {
      return Promise.resolve(this.autoResolveValue);
    }
    return new Promise<number>((resolve, reject) => {
      this.resolveFn = resolve;
      signal.addEventListener(
        'abort',
        () => reject(new OracleCancelledError('cancelled', { destination })),
        { once: true },
      );
    });
  }

  resolve(value: number): void {
    this.autoResolveValue = value;
    this.resolveFn?.(value);
  }
}

describe('CircuitBreakerOracle', () => {
  let mockOracle: MockOracle;
  let config: CircuitBreakerConfig;
  let circuitBreaker: CircuitBreakerOracle;

  beforeEach(() => {
    vi.useFakeTimers();
    mockOracle = new MockOracle();
    config = {
      failureThreshold: 3,
      cooldownWindow: 5000,
      isInfrastructureError: (error: unknown) => (error as Error).message === 'Network Error',
    };
    circuitBreaker = new CircuitBreakerOracle(mockOracle, config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in CLOSED state and passes calls to underlying oracle', async () => {
    mockOracle.getScore.mockResolvedValue(50);
    const score = await circuitBreaker.getScore('addr1');
    expect(score).toBe(50);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    expect(mockOracle.getScore).toHaveBeenCalledTimes(1);
  });

  it('transitions to OPEN after failureThreshold is reached', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));

    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it('ignores non-infrastructure errors for state transitions', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Business Error'));

    for (let i = 0; i < 5; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Business Error');
    }

    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions to HALF_OPEN after cooldownWindow', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow();
    }
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Call while OPEN fails fast
    mockOracle.getScore.mockClear();
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Circuit Breaker is OPEN');
    expect(mockOracle.getScore).not.toHaveBeenCalled();

    // Advance time
    vi.advanceTimersByTime(5000);

    // Next call should be HALF_OPEN and pass through
    mockOracle.getScore.mockResolvedValue(80);
    const score = await circuitBreaker.getScore('addr1');

    expect(score).toBe(80);
    expect(mockOracle.getScore).toHaveBeenCalledTimes(1);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('transitions from HALF_OPEN back to OPEN if probe fails', async () => {
    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow();
    }

    // Advance time to allow probe
    vi.advanceTimersByTime(5000);

    // Probe fails
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Next call should fail fast again (new cooldown)
    mockOracle.getScore.mockClear();
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Circuit Breaker is OPEN');
    expect(mockOracle.getScore).not.toHaveBeenCalled();
  });

  it('uses fallback function when OPEN', async () => {
    circuitBreaker = new CircuitBreakerOracle(mockOracle, {
      ...config,
      fallback: async () => 99,
    });

    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    for (let i = 0; i < 3; i++) {
      // First 3 calls actually reach the oracle and fail
      const result = await circuitBreaker.getScore('addr1');
      expect(result).toBe(99);
    }

    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Subsequent call uses fallback without reaching oracle
    mockOracle.getScore.mockClear();
    const fallbackScore = await circuitBreaker.getScore('addr2');
    expect(fallbackScore).toBe(99);
    expect(mockOracle.getScore).not.toHaveBeenCalled();
  });

  it('throws fallback error when OPEN', async () => {
    const fallbackError = new Error('Custom Fallback Error');
    circuitBreaker = new CircuitBreakerOracle(mockOracle, {
      ...config,
      fallback: fallbackError,
    });

    mockOracle.getScore.mockRejectedValue(new Error('Network Error'));
    for (let i = 0; i < 2; i++) {
      await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Custom Fallback Error');
    }

    // 3rd failure trips the breaker
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Custom Fallback Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    // Subsequent call throws custom error fast
    mockOracle.getScore.mockClear();
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Custom Fallback Error');
    expect(mockOracle.getScore).not.toHaveBeenCalled();
  });
});

describe('CircuitBreakerOracle: cancellation (issue #98)', () => {
  it('CLOSED: cancelling actually aborts the underlying call and is not recorded as a failure', async () => {
    const inner = new ControlledCancellableOracle();
    const config: CircuitBreakerConfig = { failureThreshold: 1, cooldownWindow: 5000 };
    const circuitBreaker = new CircuitBreakerOracle(inner, config);

    const ctrl = new AbortController();
    const pending = circuitBreaker.getScoreCancellable('addr1', ctrl.signal);
    ctrl.abort();

    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
    expect(inner.lastSignal?.aborted).toBe(true);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('rejects immediately for an already-aborted signal without calling the inner oracle', async () => {
    const inner = new ControlledCancellableOracle();
    const config: CircuitBreakerConfig = { failureThreshold: 1, cooldownWindow: 5000 };
    const circuitBreaker = new CircuitBreakerOracle(inner, config);

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(circuitBreaker.getScoreCancellable('addr1', ctrl.signal)).rejects.toBeInstanceOf(
      OracleCancelledError,
    );
    expect(inner.callCount).toBe(0);
  });

  it('HALF_OPEN: one caller cancelling its wait does not affect the shared probe or other waiters', async () => {
    const inner = new ControlledCancellableOracle();
    inner.getScore.mockRejectedValueOnce(new Error('Network Error'));
    const config: CircuitBreakerConfig = {
      failureThreshold: 1,
      cooldownWindow: 5000,
      isInfrastructureError: (error: unknown) => (error as Error).message === 'Network Error',
    };
    const circuitBreaker = new CircuitBreakerOracle(inner, config);

    // Trip the breaker to OPEN via the plain path, then let the cooldown elapse.
    await expect(circuitBreaker.getScore('addr1')).rejects.toThrow('Network Error');
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
    await vi.advanceTimersByTimeAsync(5000);

    // The HALF_OPEN probe itself always goes through the plain getScore
    // path (see runProbe), not getScoreCancellable — reconfigure the mock
    // so this probe call stays genuinely pending until resolved below,
    // instead of immediately rejecting like the trip-to-OPEN call above.
    let resolveProbe!: (value: number) => void;
    inner.getScore.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    inner.getScore.mockClear(); // isolate the call count below to just the probe call

    // Claiming caller launches the shared HALF_OPEN probe; a second caller
    // arrives while it's in flight.
    const ctrlClaim = new AbortController();
    const ctrlWaiter = new AbortController();
    const claiming = circuitBreaker.getScoreCancellable('addr1', ctrlClaim.signal);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);
    const waiting = circuitBreaker.getScoreCancellable('addr1', ctrlWaiter.signal);

    ctrlClaim.abort();
    await expect(claiming).rejects.toBeInstanceOf(OracleCancelledError);
    expect(inner.getScore).toHaveBeenCalledTimes(1); // still just the one shared probe call

    // Resolve the shared probe: this drives the breaker's own state
    // transition. Per INV-CB-4 (unchanged by this feature), the waiting
    // caller does not reuse the probe's resolved value directly — it
    // re-issues its own call once the state has settled (through
    // getScoreCancellable, since the breaker is CLOSED by then), which the
    // test double's auto-resolve handles so the exact number of microtask
    // hops needed to get there isn't something this test depends on.
    resolveProbe(64);
    inner.resolve(64);
    await expect(waiting).resolves.toBe(64);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('OPEN with cooldown not elapsed: cancelling a slow fallback rejects promptly instead of waiting for it', async () => {
    const inner = new ControlledCancellableOracle();
    let resolveFallback!: (v: number) => void;
    let fallbackCalls = 0;
    const config: CircuitBreakerConfig = {
      failureThreshold: 1,
      cooldownWindow: 5000,
      isInfrastructureError: (error: unknown) => (error as Error).message === 'Network Error',
      fallback: () => {
        fallbackCalls++;
        // The trip-to-OPEN call also routes through this fallback (CLOSED
        // path calls handleFallback on an infra error too); resolve fast
        // for that one so setup doesn't hang, and only go slow afterward,
        // for the call this test actually means to cancel.
        if (fallbackCalls === 1) return Promise.resolve(0);
        return new Promise<number>((resolve) => {
          resolveFallback = resolve;
        });
      },
    };
    const circuitBreaker = new CircuitBreakerOracle(inner, config);

    // Trip to OPEN with cooldown not yet elapsed.
    inner.getScore.mockRejectedValue(new Error('Network Error'));
    await expect(circuitBreaker.getScore('addr1')).resolves.toBe(0);
    expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

    const ctrl = new AbortController();
    const pending = circuitBreaker.getScoreCancellable('addr1', ctrl.signal);
    expect(fallbackCalls).toBe(2); // the (now slow) fallback was invoked
    ctrl.abort();

    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
    resolveFallback(1); // let the abandoned fallback settle later so nothing dangles
  });
});
