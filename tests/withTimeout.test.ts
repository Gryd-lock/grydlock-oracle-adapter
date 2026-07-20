import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OracleTimeoutError, withTimeout } from '../src/middleware/withTimeout';
import { withCache } from '../src/middleware/withCache';
import { compose } from '../src/OracleMiddleware';
import { RiskOracle } from '../src/RiskOracle';

function delayedOracle(score: number, delayMs: number): RiskOracle {
  return {
    getScore: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(score), delayMs);
      }),
  };
}

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through a result that arrives within the budget', async () => {
    const oracle = withTimeout({ timeoutMs: 1000 })(delayedOracle(42, 100));

    const pending = oracle.getScore('GDEST');
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(42);
  });

  it('rejects with OracleTimeoutError when the call exceeds the budget', async () => {
    const oracle = withTimeout({ timeoutMs: 1000 })(delayedOracle(42, 5000));

    const pending = oracle.getScore('GDEST');
    const assertion = expect(pending).rejects.toThrow(OracleTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it('names the destination and budget in the timeout error', async () => {
    const oracle = withTimeout({ timeoutMs: 250 })(delayedOracle(42, 5000));

    const pending = oracle.getScore('GDEST');
    const assertion = expect(pending).rejects.toThrow('getScore("GDEST") timed out after 250ms');
    await vi.advanceTimersByTimeAsync(250);

    await assertion;
  });

  it('propagates a fast inner failure unchanged, not as a timeout', async () => {
    const failing: RiskOracle = {
      async getScore() {
        throw new Error('oracle unreachable');
      },
    };
    const oracle = withTimeout({ timeoutMs: 1000 })(failing);

    await expect(oracle.getScore('GDEST')).rejects.toThrow('oracle unreachable');
  });

  it('does not leak an unhandled rejection when the abandoned call fails after the timeout', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const lateFailing: RiskOracle = {
        getScore: () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late failure')), 5000);
          }),
      };
      const oracle = withTimeout({ timeoutMs: 1000 })(lateFailing);

      const pending = oracle.getScore('GDEST');
      const assertion = expect(pending).rejects.toThrow(OracleTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      // Let the abandoned call fail and any rejection surface.
      await vi.advanceTimersByTimeAsync(4000);
      await vi.runAllTimersAsync();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('composed cache + timeout (recommended order)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches a fast result so repeat calls skip the slow oracle, and does not cache a timeout', async () => {
    let calls = 0;
    let delayMs = 5000;
    const flaky: RiskOracle = {
      getScore: () =>
        new Promise((resolve) => {
          calls += 1;
          setTimeout(() => resolve(42), delayMs);
        }),
    };
    const oracle = compose(withCache({ ttlMs: 60_000 }), withTimeout({ timeoutMs: 1000 }))(flaky);

    // First call: too slow → times out, and the failure is not cached.
    const first = oracle.getScore('GDEST');
    const firstAssertion = expect(first).rejects.toThrow(OracleTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await firstAssertion;
    await vi.runAllTimersAsync(); // drain the abandoned first attempt

    // Oracle recovers: second call succeeds and is cached.
    delayMs = 100;
    const second = oracle.getScore('GDEST');
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe(42);

    // Third call: served from cache — no new oracle call, no timer needed.
    expect(await oracle.getScore('GDEST')).toBe(42);
    expect(calls).toBe(2);
  });
});
