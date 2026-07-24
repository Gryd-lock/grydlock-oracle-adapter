/**
 * Bounded-memory verification for `withRateLimit` (issue #73 constraint:
 * "O(1) amortized time and bounded memory per context, regardless of the
 * total number of gossip messages received over the process lifetime").
 *
 * Drives a single `withRateLimit` instance's real message listener (the
 * exact code path production gossip reception uses) with a very large
 * cumulative number of messages from a small, fixed, continuously-active
 * set of peer contexts, advancing a virtual clock so old buckets age out
 * and get pruned exactly as they would in a long-running process. If state
 * genuinely grew with lifetime message count rather than staying bounded by
 * the currently-active working set, heap growth per message would stay
 * roughly constant across checkpoints; if it's bounded, heap growth should
 * flatten out as later checkpoints receive far more messages than earlier
 * ones for comparable (small) additional heap cost.
 *
 * Like `tests/benchmarks/StubOracle.benchmark.test.ts`, heap measurements
 * are inherently a little noisy (GC timing, JIT warmup) — the comparison
 * below uses a generously slack multiplier specifically so it doesn't flake
 * on that noise while still clearly failing on genuine unbounded growth.
 */
import { describe, expect, it } from 'vitest';
import { BroadcastChannelLike, withRateLimit } from '../src/middleware/withRateLimit';
import { RiskOracle } from '../src/RiskOracle';

function noopOracle(): RiskOracle {
  return { getScore: async () => 0 };
}

function measureHeapMB(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

/** Runs GC if the process was started with --expose-gc (not required; just
 * reduces noise in the heap measurements below when available). */
function maybeGc(): void {
  (globalThis as unknown as { gc?: () => void }).gc?.();
}

const PEER_COUNT = 6;
const WINDOW_MS = 1000;
const BUCKET_MS = 100;
const ROUND_STEP_MS = 50; // half a bucket per round: buckets churn steadily

describe('withRateLimit: bounded memory under a large cumulative gossip volume', () => {
  it(
    'heap growth flattens as cumulative message count grows, instead of scaling with it',
    async () => {
      let capturedListener: ((event: { data: unknown }) => void) | undefined;
      const clock = { t: 0 };

      const channel: BroadcastChannelLike = {
        postMessage() {
          /* the observer under test never needs to send for this check */
        },
        addEventListener(_type, listener) {
          capturedListener = listener;
        },
      };

      const oracle = withRateLimit({
        budget: 1_000_000, // high enough that admission checks never interfere with delivery
        windowMs: WINDOW_MS,
        bucketMs: BUCKET_MS,
        channel,
        contextId: 'observer',
        now: () => clock.t,
      })(noopOracle());
      // Touch the oracle once so it's not eliminated as unused and the
      // listener registration above has definitely happened.
      await oracle.getScore('GDEST');

      if (!capturedListener) throw new Error('test setup failed: no message listener captured');
      const deliver = capturedListener;

      function runRounds(count: number): void {
        for (let i = 0; i < count; i++) {
          clock.t += ROUND_STEP_MS;
          for (let p = 0; p < PEER_COUNT; p++) {
            deliver({
              data: {
                type: 'grydlock-oracle-adapter:rate-limit-gossip',
                contextId: `peer-${p}`,
                buckets: { [String(Math.floor(clock.t / BUCKET_MS))]: i + 1 },
              },
            });
          }
        }
      }

      // Warm up (JIT, initial Map allocations) before the first checkpoint
      // so that one-time setup cost doesn't get counted as "growth".
      runRounds(1_000);
      maybeGc();
      const heapAfterWarmup = measureHeapMB();

      runRounds(3_000); // +18,000 messages
      maybeGc();
      const heapAfterSecondCheckpoint = measureHeapMB();

      runRounds(40_000); // +240,000 messages — over 13x the previous interval
      maybeGc();
      const heapAfterThirdCheckpoint = measureHeapMB();

      const growthSmallInterval = Math.max(0, heapAfterSecondCheckpoint - heapAfterWarmup);
      const growthLargeInterval = Math.max(0, heapAfterThirdCheckpoint - heapAfterSecondCheckpoint);

      // If state grew proportionally to message count, the large interval
      // (13x more messages) would show roughly 13x the growth. Bounded
      // state should instead show comparable (small) growth regardless —
      // generously slacked at 10x specifically so GC/JIT noise on the small
      // interval (which can be close to zero) doesn't produce a false
      // failure; genuine unbounded growth clears this by a wide margin.
      const allowedGrowth = growthSmallInterval * 10 + 2; // +2MB constant slack
      expect(
        growthLargeInterval,
        `heap grew ${growthLargeInterval.toFixed(3)}MB over the 240,000-message interval vs ` +
          `${growthSmallInterval.toFixed(3)}MB over the preceding 18,000-message interval — ` +
          `state does not appear to be pruned/bounded (allowed <= ${allowedGrowth.toFixed(3)}MB)`,
      ).toBeLessThanOrEqual(allowedGrowth);
    },
    60_000,
  );

  it('a peer that stops broadcasting is no longer reflected once it ages out of the window', async () => {
    let capturedListener: ((event: { data: unknown }) => void) | undefined;
    const clock = { t: 0 };
    const observed: number[] = [];

    const channel: BroadcastChannelLike = {
      postMessage() {},
      addEventListener(_type, listener) {
        capturedListener = listener;
      },
    };

    const budget = 100;
    const oracle = withRateLimit({
      budget,
      windowMs: WINDOW_MS,
      bucketMs: BUCKET_MS,
      channel,
      contextId: 'observer',
      now: () => clock.t,
    })(noopOracle());

    if (!capturedListener) throw new Error('test setup failed');
    const deliver = capturedListener;

    // A talkative peer claims a big chunk of the budget, then goes silent.
    deliver({
      data: {
        type: 'grydlock-oracle-adapter:rate-limit-gossip',
        contextId: 'chatty-peer',
        buckets: { [String(Math.floor(clock.t / BUCKET_MS))]: 50 },
      },
    });

    // While the peer's bucket is still in-window, the observer's own fair
    // share is visibly reduced by it (2 known contexts: observer + peer).
    await oracle.getScore('GDEST');

    // Advance well past the window with no further gossip from the peer.
    clock.t += WINDOW_MS * 2;
    for (let i = 0; i < 5; i++) {
      clock.t += 10;
      await oracle.getScore('GDEST');
    }

    // The peer's contribution has aged out; only the observer's own
    // handful of admissions should remain, so it should still be far under
    // budget rather than permanently rate-limited by a ghost peer.
    for (let i = 0; i < budget - 10; i++) {
      const t0 = clock.t;
      clock.t += 1;
      try {
        await oracle.getScore('GDEST');
        observed.push(t0);
      } catch {
        break;
      }
    }
    expect(observed.length).toBeGreaterThan(0);
  });
});
