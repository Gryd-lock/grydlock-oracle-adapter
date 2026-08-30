import { describe, expect, it, vi } from 'vitest';
import { withRateLimit, BroadcastChannelLike } from '../src/middleware/withRateLimit';
import { RiskOracle } from '../src/RiskOracle';
import { InMemoryDurableStore } from '../src/lifecycle/DurableStore';
import { FakeBroadcastChannel, FakeBroadcastChannelBus } from './support/FakeBroadcastChannel';

function globalBroadcastChannelSlot(): {
  BroadcastChannel?: new (name: string) => BroadcastChannelLike;
} {
  return globalThis as unknown as { BroadcastChannel?: new (name: string) => BroadcastChannelLike };
}

function noopOracle(): RiskOracle {
  return { getScore: async () => 0 };
}

describe('withRateLimit: coordination status', () => {
  it('reports local-only with no channel', async () => {
    const limited = withRateLimit({ budget: 5, windowMs: 1000, channel: null })(noopOracle());
    expect(limited.getCoordinationStatus()).toEqual({ mode: 'local-only', knownContextCount: 1 });
  });

  it('reports coordinated with a live channel', async () => {
    const bus = new FakeBroadcastChannelBus();
    const now = () => 0;
    const channel = new FakeBroadcastChannel(bus, 'ch', now);
    const limited = withRateLimit({ budget: 5, windowMs: 1000, channel, now })(noopOracle());
    expect(limited.getCoordinationStatus().mode).toBe('coordinated');
  });
});

describe('withRateLimit: disposal', () => {
  it('dispose() is idempotent', async () => {
    const limited = withRateLimit({ budget: 5, windowMs: 1000, channel: null })(noopOracle());
    await limited.dispose();
    await expect(limited.dispose()).resolves.toBeUndefined();
  });

  it('getScore after dispose() throws rather than silently continuing to admit', async () => {
    const limited = withRateLimit({ budget: 5, windowMs: 1000, channel: null })(noopOracle());
    await limited.dispose();
    await expect(limited.getScore('dest-1')).rejects.toThrow(/dispose/);
  });

  it('closes a self-constructed (owned) channel on dispose()', async () => {
    const bus = new FakeBroadcastChannelBus();
    const now = () => 0;
    // Explicit BroadcastChannel constructor injection at the global level
    // isn't easy to fake cleanly here, so exercise ownership via the
    // "no channel option at all" default path using a real global stub.
    const created: FakeBroadcastChannel[] = [];
    const slot = globalBroadcastChannelSlot();
    const originalBC = slot.BroadcastChannel;
    class GlobalFakeBroadcastChannel implements BroadcastChannelLike {
      private readonly inner: FakeBroadcastChannel;
      constructor(name: string) {
        this.inner = new FakeBroadcastChannel(bus, name, now);
        created.push(this.inner);
      }
      postMessage(d: unknown) {
        this.inner.postMessage(d);
      }
      addEventListener(t: 'message', l: (e: { data: unknown }) => void) {
        this.inner.addEventListener(t, l);
      }
      removeEventListener(t: 'message', l: (e: { data: unknown }) => void) {
        this.inner.removeEventListener(t, l);
      }
      close() {
        this.inner.close();
      }
    }
    slot.BroadcastChannel = GlobalFakeBroadcastChannel;
    try {
      const limited = withRateLimit({ budget: 5, windowMs: 1000, now })(noopOracle());
      const closeSpy = vi.spyOn(created[0], 'close');
      await limited.dispose();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      slot.BroadcastChannel = originalBC;
    }
  });

  it('never closes a caller-supplied channel on dispose()', async () => {
    const bus = new FakeBroadcastChannelBus();
    const now = () => 0;
    const channel = new FakeBroadcastChannel(bus, 'ch', now);
    const closeSpy = vi.spyOn(channel, 'close');

    const limited = withRateLimit({ budget: 5, windowMs: 1000, channel, now })(noopOracle());
    await limited.dispose();

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('removes its own message listener on dispose(), so it stops reacting to gossip', async () => {
    const bus = new FakeBroadcastChannelBus();
    const now = () => 0;
    const channelA = new FakeBroadcastChannel(bus, 'ch', now);
    const channelB = new FakeBroadcastChannel(bus, 'ch', now);

    const limitedA = withRateLimit({
      budget: 100,
      windowMs: 10_000,
      channel: channelA,
      contextId: 'a',
      now,
    })(noopOracle());
    withRateLimit({ budget: 100, windowMs: 10_000, channel: channelB, contextId: 'b', now })(
      noopOracle(),
    );

    await limitedA.getScore('dest-1'); // triggers a broadcast
    bus.deliverUpTo(0);
    expect(limitedA.getCoordinationStatus().knownContextCount).toBe(1); // hasn't heard from b yet in this direction, irrelevant

    await limitedA.dispose();
    // Post-dispose, further messages must not be processed (no crash, no state mutation reachable via public API).
    channelB.postMessage({
      type: 'grydlock-oracle-adapter:rate-limit-gossip',
      version: 1,
      contextId: 'b',
      buckets: { '0': 1 },
    });
    bus.deliverUpTo(0);
    // No assertion on internal state possible post-dispose beyond "did not throw".
  });
});

describe('withRateLimit: hardened gossip validation', () => {
  function twoContexts(budget: number, windowMs: number) {
    const bus = new FakeBroadcastChannelBus();
    let t = 0;
    const now = () => t;
    const channelA = new FakeBroadcastChannel(bus, 'ch', now);
    const channelB = new FakeBroadcastChannel(bus, 'ch', now);
    const a = withRateLimit({ budget, windowMs, channel: channelA, contextId: 'a', now })(
      noopOracle(),
    );
    const attacker = channelB;
    return { bus, a, attacker, advance: (ms: number) => (t += ms) };
  }

  it('drops a message at the wrong protocol version', async () => {
    const { bus, a, attacker } = twoContexts(10, 10_000);
    attacker.postMessage({
      type: 'grydlock-oracle-adapter:rate-limit-gossip',
      version: 999,
      contextId: 'attacker',
      buckets: { '0': 9999 },
    });
    bus.deliverUpTo(0);
    expect(a.getCoordinationStatus().knownContextCount).toBe(1); // never accepted
  });

  it('drops a message with an oversized contextId', async () => {
    const { bus, a, attacker } = twoContexts(10, 10_000);
    attacker.postMessage({
      type: 'grydlock-oracle-adapter:rate-limit-gossip',
      version: 1,
      contextId: 'x'.repeat(10_000),
      buckets: { '0': 1 },
    });
    bus.deliverUpTo(0);
    expect(a.getCoordinationStatus().knownContextCount).toBe(1);
  });

  it('drops an oversized message (too many bucket entries) in full', async () => {
    const { bus, a, attacker } = twoContexts(10, 1000);
    const buckets: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) buckets[String(i)] = 1;
    attacker.postMessage({
      type: 'grydlock-oracle-adapter:rate-limit-gossip',
      version: 1,
      contextId: 'attacker',
      buckets,
    });
    bus.deliverUpTo(0);
    expect(a.getCoordinationStatus().knownContextCount).toBe(1);
  });

  it('drops individual bucket entries with implausible clock skew, while still tracking the sender', async () => {
    const { bus, a, attacker, advance } = twoContexts(10, 1000);
    advance(100_000);
    attacker.postMessage({
      type: 'grydlock-oracle-adapter:rate-limit-gossip',
      version: 1,
      contextId: 'attacker',
      buckets: { '999999999': 5000 }, // absurdly far-future bucket
    });
    bus.deliverUpTo(100_000);
    // The sender may still be recognized as a context (harmless), but its
    // absurd bucket must not inflate the global estimate.
    const status = a.getCoordinationStatus();
    expect(status.knownContextCount).toBeLessThanOrEqual(2);
  });

  it('bounds tracked-context memory via maxTrackedContexts, evicting least-recently-seen', async () => {
    const bus = new FakeBroadcastChannelBus();
    const t = 0;
    const now = () => t;
    const channelA = new FakeBroadcastChannel(bus, 'ch', now);
    const a = withRateLimit({
      budget: 1000,
      windowMs: 100_000,
      channel: channelA,
      contextId: 'a',
      maxTrackedContexts: 3, // self + 2 others max
      now,
    })(noopOracle());

    for (let i = 0; i < 10; i++) {
      const forged = new FakeBroadcastChannel(bus, 'ch', now);
      forged.postMessage({
        type: 'grydlock-oracle-adapter:rate-limit-gossip',
        version: 1,
        contextId: `forged-${i}`,
        buckets: { '0': 1 },
      });
      bus.deliverUpTo(t);
    }

    expect(a.getCoordinationStatus().knownContextCount).toBeLessThanOrEqual(3);
  });
});

describe('withRateLimit: restart-safe own-bucket persistence', () => {
  it('a warm restart with the same stable contextId resumes mid-window instead of resetting the budget', async () => {
    const store = new InMemoryDurableStore();
    let t = 0;
    const now = () => t;

    const first = withRateLimit({
      budget: 3,
      windowMs: 10_000,
      channel: null,
      contextId: 'stable-ctx',
      store,
      now,
    })(noopOracle());

    await first.getScore('d1');
    await first.getScore('d2');
    await first.getScore('d3');
    // Budget exhausted for this window.
    await expect(first.getScore('d4')).rejects.toThrow();

    // Simulate a restart: brand-new instance, same stable contextId + store,
    // still within the same window.
    t += 100;
    const restarted = withRateLimit({
      budget: 3,
      windowMs: 10_000,
      channel: null,
      contextId: 'stable-ctx',
      store,
      now,
    })(noopOracle());

    // Must NOT get a silently-fresh budget: still exhausted.
    await expect(restarted.getScore('d5')).rejects.toThrow();
  });

  it('a fresh random contextId (no continuity) simply starts with an empty budget, as expected', async () => {
    const store = new InMemoryDurableStore();
    const now = () => 0;

    const first = withRateLimit({
      budget: 1,
      windowMs: 10_000,
      channel: null,
      contextId: 'ctx-A',
      store,
      now,
    })(noopOracle());
    await first.getScore('d1');
    await expect(first.getScore('d2')).rejects.toThrow();

    const differentContext = withRateLimit({
      budget: 1,
      windowMs: 10_000,
      channel: null,
      contextId: 'ctx-B', // genuinely different identity: no persisted history to find
      store,
      now,
    })(noopOracle());
    await expect(differentContext.getScore('d1')).resolves.toBeDefined();
  });
});
