/**
 * Verifies the acceptance criterion "degrade gracefully to single-context
 * behavior... not merely close but exact" for issue #73's rate limiter.
 *
 * With no `BroadcastChannel` supplied (`channel: null`), `withRateLimit`
 * should behave as an exact bucketed sliding-window rate limiter — the same
 * class of "correct single-process rate limiter" design it uses internally,
 * just without any gossip machinery. `BaselineSlidingWindowLimiter` below is
 * an independent, from-scratch implementation of that same algorithm class,
 * used only as a reference to compare against; it does not import or share
 * code with `withRateLimit`.
 */
import { describe, expect, it } from 'vitest';
import { withRateLimit } from '../src/middleware/withRateLimit';
import { RiskOracle } from '../src/RiskOracle';
import { seededRandom } from './support/seededRandom';

/** Independent reference implementation: bucketed sliding-window counter. */
class BaselineSlidingWindowLimiter {
  private readonly buckets = new Map<number, number>();
  private readonly bucketsPerWindow: number;

  constructor(
    private readonly budget: number,
    private readonly windowMs: number,
    private readonly bucketMs: number,
  ) {
    this.bucketsPerWindow = Math.max(1, Math.ceil(windowMs / bucketMs));
  }

  private bucketIndexAt(t: number): number {
    return Math.floor(t / this.bucketMs);
  }

  private prune(t: number): void {
    const minBucket = this.bucketIndexAt(t) - this.bucketsPerWindow + 1;
    for (const b of this.buckets.keys()) {
      if (b < minBucket) this.buckets.delete(b);
    }
  }

  private count(): number {
    let sum = 0;
    for (const c of this.buckets.values()) sum += c;
    return sum;
  }

  tryAdmit(t: number): boolean {
    this.prune(t);
    if (this.count() + 1 > this.budget) return false;
    const b = this.bucketIndexAt(t);
    this.buckets.set(b, (this.buckets.get(b) ?? 0) + 1);
    return true;
  }
}

function noopOracle(): RiskOracle {
  return { getScore: async () => 0 };
}

async function tryAdmitViaOracle(oracle: RiskOracle): Promise<boolean> {
  try {
    await oracle.getScore('GDEST');
    return true;
  } catch {
    return false;
  }
}

describe('withRateLimit with no BroadcastChannel: exact match to a baseline single-process limiter', () => {
  it('produces an identical admit/deny decision, call for call, across randomized request timing (many trials)', async () => {
    const random = seededRandom(42);
    const TRIALS = 60;
    const CALLS_PER_TRIAL = 300;

    for (let trial = 0; trial < TRIALS; trial++) {
      const budget = 5 + Math.floor(random() * 20); // 5..24
      const windowMs = 1000 + Math.floor(random() * 4000); // 1000..5000
      const bucketMs = 100 + Math.floor(random() * 400); // 100..500

      let virtualNow = 0;
      const oracle = withRateLimit({
        budget,
        windowMs,
        bucketMs,
        channel: null, // explicit local-only mode — the case under test
        now: () => virtualNow,
      })(noopOracle());
      const baseline = new BaselineSlidingWindowLimiter(budget, windowMs, bucketMs);

      for (let call = 0; call < CALLS_PER_TRIAL; call++) {
        // Random, sometimes-bursty gaps: many calls at the same instant,
        // occasional large jumps forward (so buckets actually expire).
        const gap =
          random() < 0.3 ? 0 : Math.floor(random() * (windowMs / 2));
        virtualNow += gap;

        const [actual, expected] = await Promise.all([
          tryAdmitViaOracle(oracle),
          Promise.resolve(baseline.tryAdmit(virtualNow)),
        ]);

        expect(
          actual,
          `trial ${trial} call ${call}: budget=${budget}, windowMs=${windowMs}, ` +
            `bucketMs=${bucketMs}, t=${virtualNow} — withRateLimit=${actual}, baseline=${expected}`,
        ).toBe(expected);
      }
    }
  });

  it('admits exactly budget requests in a burst at t=0, then denies the next one', async () => {
    const budget = 10;
    let virtualNow = 0;
    const oracle = withRateLimit({
      budget,
      windowMs: 1000,
      bucketMs: 100,
      channel: null,
      now: () => virtualNow,
    })(noopOracle());

    for (let i = 0; i < budget; i++) {
      await expect(oracle.getScore('GDEST')).resolves.toBe(0);
    }
    await expect(oracle.getScore('GDEST')).rejects.toThrow(/rate limiter/);
  });

  it('admits again once the window has fully rolled past the burst', async () => {
    const budget = 4;
    let virtualNow = 0;
    const oracle = withRateLimit({
      budget,
      windowMs: 1000,
      bucketMs: 100,
      channel: null,
      now: () => virtualNow,
    })(noopOracle());

    for (let i = 0; i < budget; i++) {
      await oracle.getScore('GDEST');
    }
    await expect(oracle.getScore('GDEST')).rejects.toThrow();

    virtualNow += 1000; // fully past the window
    for (let i = 0; i < budget; i++) {
      await expect(oracle.getScore('GDEST')).resolves.toBe(0);
    }
  });
});
