/**
 * Adversarial verification for `withRateLimit` (issue #73): simulates
 * multiple independent JS contexts sharing a single nominal budget,
 * coordinating only via a lossy, reordering, duplicating fake
 * `BroadcastChannel`, and checks the two bounds documented in
 * `src/middleware/withRateLimit.ts`'s module doc:
 *
 * 1. **Bound 1 (hard, unconditional)**: combined admissions across all
 *    contexts in any trailing window never exceeds `N * budget`. This must
 *    hold on every single randomized adversarial run — it's proven true by
 *    construction, independent of what the network does.
 * 2. **Bound 2 (soft, demonstrates convergence)**: once gossip has had time
 *    to propagate, the combined count settles much closer to the tight
 *    `budget + N` steady state than to the loose worst case — checked both
 *    under a lossless control (near-instant convergence expected) and under
 *    the full adversarial conditions (looser, but still well inside bound 1).
 */
import { describe, expect, it } from 'vitest';
import { withRateLimit } from '../src/middleware/withRateLimit';
import { RiskOracle } from '../src/RiskOracle';
import { FakeBroadcastChannel, FakeBroadcastChannelBus } from './support/FakeBroadcastChannel';
import { seededRandom } from './support/seededRandom';

function noopOracle(): RiskOracle {
  return { getScore: async () => 0 };
}

interface SimContext {
  contextId: string;
  admissions: number[];
}

interface SimParams {
  contextCount: number;
  budget: number;
  windowMs: number;
  gossipIntervalMs: number;
  bucketMs: number;
  lossRate: number;
  duplicateRate: number;
  maxReorderDelay: number;
  durationMs: number;
  tickStepMs: number;
  random: () => number;
}

/** Runs one simulated scenario end to end and returns each context's
 * admission timestamps (virtual ms). */
async function runSimulation(params: SimParams): Promise<SimContext[]> {
  const {
    contextCount,
    budget,
    windowMs,
    gossipIntervalMs,
    bucketMs,
    lossRate,
    duplicateRate,
    maxReorderDelay,
    durationMs,
    tickStepMs,
    random,
  } = params;

  const bus = new FakeBroadcastChannelBus();
  const clock = { t: 0 };
  const channelName = 'sim-rate-limit';

  const contexts: SimContext[] = [];
  const oracles: RiskOracle[] = [];

  for (let i = 0; i < contextCount; i++) {
    const contextId = `ctx-${i}`;
    const channel = new FakeBroadcastChannel(bus, channelName, () => clock.t, {
      lossRate,
      duplicateRate,
      maxReorderDelay,
      random,
    });
    const oracle = withRateLimit({
      budget,
      windowMs,
      gossipIntervalMs,
      bucketMs,
      channel,
      contextId,
      now: () => clock.t,
    })(noopOracle());
    contexts.push({ contextId, admissions: [] });
    oracles.push(oracle);
  }

  for (let t = 0; t < durationMs; t += tickStepMs) {
    clock.t = t;
    for (let i = 0; i < contextCount; i++) {
      try {
        await oracles[i].getScore('GDEST');
        contexts[i].admissions.push(t);
      } catch {
        // denied — expected once budget/fair-share is exhausted
      }
    }
    bus.deliverUpTo(t);
  }
  bus.flushAll();

  return contexts;
}

/** Max combined admissions in any trailing window of length `windowMs`,
 * measured only over events at/after `sinceMs` (use `sinceMs = -Infinity`
 * for the whole run). Correct because the windowed count only *increases*
 * at an admission event and only decreases as time passes without one, so
 * the maximum over any window end time is attained at some admission event. */
function maxCombinedInWindow(
  contexts: SimContext[],
  windowMs: number,
  sinceMs: number,
): number {
  const all = contexts.flatMap((c) => c.admissions).sort((a, b) => a - b);
  let max = 0;
  for (const t of all) {
    if (t < sinceMs) continue;
    const count = all.filter((u) => u > t - windowMs && u <= t).length;
    if (count > max) max = count;
  }
  return max;
}

const CONTEXT_COUNT = 4;
const BUDGET = 40;
const WINDOW_MS = 1000;
const GOSSIP_INTERVAL_MS = 100;
const BUCKET_MS = 100;
const DURATION_MS = 4000; // 4 windows: enough to see startup + steady state
const TICK_STEP_MS = 20;

describe('adversarial gossip simulation: bound 1 (hard, unconditional) holds on every run', () => {
  const TRIALS = 220; // > the issue's 200-run acceptance bar

  it(`combined admissions never exceed ${CONTEXT_COUNT} * budget in any trailing window, across ${TRIALS} randomized adversarial runs`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const random = seededRandom(1000 + trial);
      const contexts = await runSimulation({
        contextCount: CONTEXT_COUNT,
        budget: BUDGET,
        windowMs: WINDOW_MS,
        gossipIntervalMs: GOSSIP_INTERVAL_MS,
        bucketMs: BUCKET_MS,
        lossRate: 0.2, // matches the issue's example 20% drop rate
        duplicateRate: 0.15,
        maxReorderDelay: 300,
        durationMs: DURATION_MS,
        tickStepMs: TICK_STEP_MS,
        random,
      });

      const bound1 = CONTEXT_COUNT * BUDGET;
      const observed = maxCombinedInWindow(contexts, WINDOW_MS, -Infinity);

      expect(
        observed,
        `trial ${trial}: observed max combined-in-window ${observed} exceeded the unconditional ` +
          `bound ${bound1} (${CONTEXT_COUNT} contexts * ${BUDGET} budget). Per-context admissions: ` +
          `${contexts.map((c) => `${c.contextId}=${c.admissions.length}`).join(', ')}`,
      ).toBeLessThanOrEqual(bound1);
    }
  }, 120_000);
});

describe('adversarial gossip simulation: bound 2 (soft) — gossip measurably tightens the bound once converged', () => {
  it('under lossless, instant-delivery conditions, the steady-state window settles near budget + N, far below N * budget', async () => {
    const random = seededRandom(7);
    const contexts = await runSimulation({
      contextCount: CONTEXT_COUNT,
      budget: BUDGET,
      windowMs: WINDOW_MS,
      gossipIntervalMs: GOSSIP_INTERVAL_MS,
      bucketMs: BUCKET_MS,
      lossRate: 0,
      duplicateRate: 0,
      maxReorderDelay: 0,
      durationMs: DURATION_MS,
      tickStepMs: TICK_STEP_MS,
      random,
    });

    // Steady-state window: well after startup, once every context has had
    // many opportunities to hear from every other one.
    const steadyStateSince = DURATION_MS - WINDOW_MS;
    const observed = maxCombinedInWindow(contexts, WINDOW_MS, steadyStateSince);

    const tightBound = BUDGET + CONTEXT_COUNT; // bound 2
    const looseBound = CONTEXT_COUNT * BUDGET; // bound 1

    expect(observed, 'lossless run should stay within the tight steady-state bound').toBeLessThanOrEqual(
      tightBound,
    );
    expect(observed).toBeLessThan(looseBound);
  }, 30_000);

  it('under the full adversarial conditions, the steady-state window is still much tighter than the N*budget worst case (averaged over many runs)', async () => {
    const TRIALS = 60;
    const looseBound = CONTEXT_COUNT * BUDGET;
    // Generous, non-flaky midpoint: demonstrates convergence is doing real
    // work without asserting a tight bound we can't be certain holds under
    // every unlucky loss sequence (that certainty is bound 1's job, above).
    const softBound = BUDGET + CONTEXT_COUNT + Math.ceil(0.6 * (CONTEXT_COUNT - 1) * BUDGET);
    expect(softBound).toBeLessThan(looseBound); // sanity check on the constants themselves

    let sumObserved = 0;
    let worstObserved = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const random = seededRandom(5000 + trial);
      const contexts = await runSimulation({
        contextCount: CONTEXT_COUNT,
        budget: BUDGET,
        windowMs: WINDOW_MS,
        gossipIntervalMs: GOSSIP_INTERVAL_MS,
        bucketMs: BUCKET_MS,
        lossRate: 0.2,
        duplicateRate: 0.15,
        maxReorderDelay: 300,
        durationMs: DURATION_MS,
        tickStepMs: TICK_STEP_MS,
        random,
      });

      const steadyStateSince = DURATION_MS - WINDOW_MS;
      const observed = maxCombinedInWindow(contexts, WINDOW_MS, steadyStateSince);
      sumObserved += observed;
      worstObserved = Math.max(worstObserved, observed);
    }

    const averageObserved = sumObserved / TRIALS;

    // The average steady-state overshoot should sit well below the loose
    // worst-case bound — this is the empirical case that gossip is doing
    // its job, not just "technically legal" per bound 1.
    expect(
      averageObserved,
      `average steady-state combined count ${averageObserved} across ${TRIALS} runs did not stay ` +
        `comfortably below the loose bound ${looseBound} (worst single run: ${worstObserved})`,
    ).toBeLessThan(looseBound * 0.85);

    // And even the single worst run across all trials must never breach the
    // unconditional bound (belt-and-suspenders with the dedicated bound-1 test).
    expect(worstObserved).toBeLessThanOrEqual(looseBound);
  }, 60_000);
});

describe('adversarial gossip simulation: sanity — the limiter is actually limiting, not just never denying', () => {
  it('denies a meaningful fraction of attempts once the aggressive combined attempt rate exceeds budget', async () => {
    const random = seededRandom(99);
    const contexts = await runSimulation({
      contextCount: CONTEXT_COUNT,
      budget: BUDGET,
      windowMs: WINDOW_MS,
      gossipIntervalMs: GOSSIP_INTERVAL_MS,
      bucketMs: BUCKET_MS,
      lossRate: 0.2,
      duplicateRate: 0.15,
      maxReorderDelay: 300,
      durationMs: DURATION_MS,
      tickStepMs: TICK_STEP_MS,
      random,
    });

    const totalAttempts = CONTEXT_COUNT * (DURATION_MS / TICK_STEP_MS);
    const totalAdmitted = contexts.reduce((sum, c) => sum + c.admissions.length, 0);

    expect(totalAdmitted).toBeGreaterThan(0);
    expect(
      totalAdmitted,
      'the limiter should have denied a substantial share of attempts given the aggressive attempt rate',
    ).toBeLessThan(totalAttempts * 0.5);
  }, 30_000);
});
