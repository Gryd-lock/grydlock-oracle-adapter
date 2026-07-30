/**
 * Core behavioral tests for `withRateLimit` (issue #73): option validation,
 * basic admit/deny, error shape, composition via `compose()`, and a
 * non-adversarial two-context sanity check that gossip actually shares the
 * budget (the adversarial/property/single-context/memory guarantees each
 * have their own dedicated files alongside this one).
 */
import { describe, expect, it } from 'vitest';
import { OracleRateLimitError, withRateLimit } from '../src/middleware/withRateLimit';
import { compose } from '../src/OracleMiddleware';
import { RiskOracle } from '../src/RiskOracle';
import { FakeBroadcastChannel, FakeBroadcastChannelBus } from './support/FakeBroadcastChannel';

function noopOracle(): RiskOracle {
  return { getScore: async () => 7 };
}

describe('withRateLimit: option validation', () => {
  it('throws RangeError for a non-positive budget', () => {
    expect(() => withRateLimit({ budget: 0, windowMs: 1000, channel: null })).toThrow(RangeError);
    expect(() => withRateLimit({ budget: -5, windowMs: 1000, channel: null })).toThrow(RangeError);
  });

  it('throws RangeError for a non-positive windowMs', () => {
    expect(() => withRateLimit({ budget: 10, windowMs: 0, channel: null })).toThrow(RangeError);
  });

  it('throws RangeError for a non-positive bucketMs', () => {
    expect(() =>
      withRateLimit({ budget: 10, windowMs: 1000, bucketMs: -1, channel: null }),
    ).toThrow(RangeError);
  });
});

describe('withRateLimit: basic admit/deny (local-only, no channel)', () => {
  it('admits up to budget, then denies with OracleRateLimitError', async () => {
    const oracle = withRateLimit({
      budget: 3,
      windowMs: 1000,
      channel: null,
      now: () => 0,
    })(noopOracle());

    await expect(oracle.getScore('GDEST')).resolves.toBe(7);
    await expect(oracle.getScore('GDEST')).resolves.toBe(7);
    await expect(oracle.getScore('GDEST')).resolves.toBe(7);
    await expect(oracle.getScore('GDEST')).rejects.toBeInstanceOf(OracleRateLimitError);
  });

  it('the thrown error carries structured details for debugging', async () => {
    const oracle = withRateLimit({
      budget: 1,
      windowMs: 1000,
      channel: null,
      contextId: 'ctx-test',
    })(noopOracle());

    await oracle.getScore('GDEST');
    await expect(oracle.getScore('GA...DENIED')).rejects.toMatchObject({
      name: 'OracleRateLimitError',
      details: expect.objectContaining({
        budget: 1,
        windowMs: 1000,
        contextId: 'ctx-test',
      }),
    });
  });

  it('does not call the wrapped oracle when a request is denied', async () => {
    let calls = 0;
    const counting: RiskOracle = {
      async getScore() {
        calls += 1;
        return 1;
      },
    };
    const oracle = withRateLimit({ budget: 1, windowMs: 1000, channel: null })(counting);

    await oracle.getScore('GDEST');
    await expect(oracle.getScore('GDEST')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('composes via compose() like any other OracleMiddleware', async () => {
    const oracle = compose(withRateLimit({ budget: 2, windowMs: 1000, channel: null }))(noopOracle());
    await expect(oracle.getScore('GDEST')).resolves.toBe(7);
    await expect(oracle.getScore('GDEST')).resolves.toBe(7);
    await expect(oracle.getScore('GDEST')).rejects.toBeInstanceOf(OracleRateLimitError);
  });
});

describe('withRateLimit: two contexts sharing a lossless fake channel', () => {
  it('a second context is denied once the first has consumed the shared budget and gossip has propagated', async () => {
    const bus = new FakeBroadcastChannelBus();
    const clock = { t: 0 };
    const channelA = new FakeBroadcastChannel(bus, 'shared', () => clock.t);
    const channelB = new FakeBroadcastChannel(bus, 'shared', () => clock.t);

    const oracleA = withRateLimit({
      budget: 4,
      windowMs: 1000,
      gossipIntervalMs: 10,
      bucketMs: 10,
      channel: channelA,
      contextId: 'A',
      now: () => clock.t,
    })(noopOracle());
    const oracleB = withRateLimit({
      budget: 4,
      windowMs: 1000,
      gossipIntervalMs: 10,
      bucketMs: 10,
      channel: channelB,
      contextId: 'B',
      now: () => clock.t,
    })(noopOracle());

    // A consumes the whole shared budget and broadcasts after each admission.
    for (let i = 0; i < 4; i++) {
      clock.t = i * 10;
      await oracleA.getScore('GDEST');
      bus.deliverUpTo(clock.t); // deliver A's broadcast to B immediately (lossless)
    }

    // B has now heard A claim the whole budget — B's own attempt must be denied.
    clock.t = 100;
    await expect(oracleB.getScore('GDEST')).rejects.toBeInstanceOf(OracleRateLimitError);
  });

  it('a fresh context with nobody else on the channel gets the full budget (roster of 1)', async () => {
    const bus = new FakeBroadcastChannelBus();
    const clock = { t: 0 };
    const channel = new FakeBroadcastChannel(bus, 'solo', () => clock.t);
    const oracle = withRateLimit({
      budget: 5,
      windowMs: 1000,
      channel,
      contextId: 'solo-ctx',
      now: () => clock.t,
    })(noopOracle());

    for (let i = 0; i < 5; i++) {
      await expect(oracle.getScore('GDEST')).resolves.toBe(7);
    }
    await expect(oracle.getScore('GDEST')).rejects.toBeInstanceOf(OracleRateLimitError);
  });
});
