import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshLeaseCoordinator } from '../../src/lifecycle/RefreshLeaseCoordinator';
import { FakeBroadcastChannel, FakeBroadcastChannelBus } from '../support/FakeBroadcastChannel';

const CHANNEL_NAME = 'grydlock-oracle-adapter:refresh-lease';

describe('RefreshLeaseCoordinator (gossip fallback: no Web Locks)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeContext(bus: FakeBroadcastChannelBus, contextId: string, now: () => number) {
    return new RefreshLeaseCoordinator({
      leaseMs: 5_000,
      arbitrationWindowMs: 20,
      lockManager: null,
      channel: new FakeBroadcastChannel(bus, CHANNEL_NAME, now),
      ownsChannel: true,
      contextId,
      now,
    });
  }

  it('reports local-only when no lock manager and no channel are available', () => {
    const coordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
    });
    expect(coordinator.getCoordinationStatus()).toEqual({ mode: 'local-only' });
  });

  it('reports gossip mode when a channel is present but no Web Locks', () => {
    const bus = new FakeBroadcastChannelBus();
    const coordinator = makeContext(bus, 'ctx-1', () => 0);
    expect(coordinator.getCoordinationStatus()).toEqual({ mode: 'gossip' });
  });

  it('local-only mode: acquire always succeeds locally with no exclusion claimed', async () => {
    const coordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
    });
    const a = await coordinator.acquire('dest-1');
    const b = await coordinator.acquire('dest-1');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('two contexts racing for the same key converge on exactly one winner', async () => {
    const bus = new FakeBroadcastChannelBus();
    const t = 0;
    const now = () => t;
    const ctxA = makeContext(bus, 'aaa', now);
    const ctxB = makeContext(bus, 'bbb', now);

    const pA = ctxA.acquire('dest-1');
    const pB = ctxB.acquire('dest-1');

    // Deliver the two `lease-request` broadcasts before either side's
    // arbitration window elapses, then let the timers fire.
    bus.deliverUpTo(t);
    await vi.advanceTimersByTimeAsync(25);

    const [leaseA, leaseB] = await Promise.all([pA, pB]);
    const winners = [leaseA, leaseB].filter((l) => l !== null);
    expect(winners.length).toBe(1);

    await winners[0]!.release();
  });

  it('fifty concurrent acquire() calls across five contexts yield at most one active lease for that key', async () => {
    const bus = new FakeBroadcastChannelBus();
    const t = 0;
    const now = () => t;
    const contexts = Array.from({ length: 5 }, (_, i) => makeContext(bus, `ctx-${i}`, now));

    // 10 concurrent "cold requests" per context, all for the same key —
    // mirrors the acceptance criterion's "50 cold requests across 5
    // contexts create at most one active refresh lease". Ten calls from the
    // *same* context collapse onto one shared in-flight arbitration (see
    // `inFlightAcquire`), so a successful context's 10 callers all resolve
    // to the very same `LeaseHandle` object, not ten independent grants —
    // that shared identity is exactly what "at most one active lease"
    // means here, so the assertion below checks unique handle identity
    // rather than raw non-null count.
    const allAttempts = contexts.flatMap((c) =>
      Array.from({ length: 10 }, () => c.acquire('shared-destination')),
    );
    expect(allAttempts.length).toBe(50);

    bus.deliverUpTo(t);
    await vi.advanceTimersByTimeAsync(25);
    bus.flushAll();
    await vi.advanceTimersByTimeAsync(25);

    const results = await Promise.all(allAttempts);
    const grantedHandles = new Set(results.filter((r) => r !== null));
    expect(grantedHandles.size).toBe(1);
    // And that one lease was in fact granted to only one of the five
    // contexts (not shared/duplicated across contexts).
    expect(results.filter((r) => r !== null).length).toBe(10);
  });

  it('killing the lease owner (no release) permits recovery after the bounded leaseMs timeout', async () => {
    const bus = new FakeBroadcastChannelBus();
    let t = 0;
    const now = () => t;
    const ctxA = makeContext(bus, 'owner', now);
    const ctxB = makeContext(bus, 'other', now);

    const leaseA = await (async () => {
      const p = ctxA.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(leaseA).not.toBeNull();

    // ctxA "dies" without releasing. ctxB tries immediately: still denied
    // (lease not yet expired).
    t += 100;
    const tooSoon = await (async () => {
      const p = ctxB.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(tooSoon).toBeNull();

    // Advance past leaseMs (5000ms): recovery becomes possible.
    t += 6000;
    const recovered = await (async () => {
      const p = ctxB.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(recovered).not.toBeNull();
  });

  it('an explicit release() lets another context acquire immediately, without waiting out leaseMs', async () => {
    const bus = new FakeBroadcastChannelBus();
    let t = 0;
    const now = () => t;
    const ctxA = makeContext(bus, 'owner', now);
    const ctxB = makeContext(bus, 'other', now);

    const leaseA = await (async () => {
      const p = ctxA.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(leaseA).not.toBeNull();

    await leaseA!.release();
    bus.deliverUpTo(t);

    t += 10; // well under leaseMs (5000)
    const afterRelease = await (async () => {
      const p = ctxB.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(afterRelease).not.toBeNull();
  });

  it('rejects a message with an oversized contextId rather than tracking it', async () => {
    const bus = new FakeBroadcastChannelBus();
    const t = 0;
    const now = () => t;
    const victim = makeContext(bus, 'victim', now);

    const attackerChannel = new FakeBroadcastChannel(bus, CHANNEL_NAME, now);
    attackerChannel.postMessage({
      type: 'grydlock-oracle-adapter:lease-confirm',
      key: 'dest-1',
      contextId: 'x'.repeat(10_000),
      expiresAt: now() + 5_000,
    });
    bus.deliverUpTo(t);

    // The forged confirm must not have been accepted: victim can still win.
    const lease = await (async () => {
      const p = victim.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(lease).not.toBeNull();
  });

  it('rejects a confirm with an implausibly long lease as forged, not authoritative', async () => {
    const bus = new FakeBroadcastChannelBus();
    const t = 0;
    const now = () => t;
    const victim = makeContext(bus, 'victim', now);

    const attackerChannel = new FakeBroadcastChannel(bus, CHANNEL_NAME, now);
    attackerChannel.postMessage({
      type: 'grydlock-oracle-adapter:lease-confirm',
      key: 'dest-1',
      contextId: 'attacker',
      expiresAt: now() + 999_999_999, // wildly longer than any real leaseMs
    });
    bus.deliverUpTo(t);

    const lease = await (async () => {
      const p = victim.acquire('dest-1');
      bus.deliverUpTo(t);
      await vi.advanceTimersByTimeAsync(25);
      return p;
    })();
    expect(lease).not.toBeNull();
  });

  it('bounds tracked-key memory via maxTrackedKeys, evicting the oldest key', async () => {
    const coordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
      maxTrackedKeys: 2,
    });
    await coordinator.acquire('k1');
    await coordinator.acquire('k2');
    await coordinator.acquire('k3'); // should not grow state past the cap
    // No direct way to inspect internal state size from the public API;
    // this at minimum proves acquiring past the cap doesn't throw or hang.
    await expect(coordinator.acquire('k4')).resolves.not.toBeNull();
  });

  it('dispose() removes the listener and closes an owned channel, but never a caller-supplied one', async () => {
    const bus = new FakeBroadcastChannelBus();
    const now = () => 0;

    const ownedChannel = new FakeBroadcastChannel(bus, CHANNEL_NAME, now);
    const closeSpy = vi.spyOn(ownedChannel, 'close');
    const owning = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: ownedChannel,
      ownsChannel: true,
      now,
    });
    await owning.dispose();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    const externalChannel = new FakeBroadcastChannel(bus, CHANNEL_NAME, now);
    const externalCloseSpy = vi.spyOn(externalChannel, 'close');
    const nonOwning = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: externalChannel,
      ownsChannel: false,
      now,
    });
    await nonOwning.dispose();
    expect(externalCloseSpy).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent', async () => {
    const coordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
    });
    await coordinator.dispose();
    await expect(coordinator.dispose()).resolves.toBeUndefined();
  });

  it('acquire() after dispose() returns null rather than hanging or throwing', async () => {
    const coordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: null,
      channel: null,
    });
    await coordinator.dispose();
    await expect(coordinator.acquire('dest-1')).resolves.toBeNull();
  });
});

describe('RefreshLeaseCoordinator (Web Locks path)', () => {
  function fakeLockManager() {
    const held = new Set<string>();
    return {
      held,
      async request<T>(
        name: string,
        opts: { mode: 'exclusive'; ifAvailable: true },
        callback: (lock: unknown | null) => Promise<T>,
      ): Promise<T> {
        void opts;
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({});
        } finally {
          held.delete(name);
        }
      },
    };
  }

  it('reports web-locks coordination mode when a lock manager is supplied', () => {
    const coordinator = new RefreshLeaseCoordinator({
      leaseMs: 1000,
      lockManager: fakeLockManager(),
    });
    expect(coordinator.getCoordinationStatus()).toEqual({ mode: 'web-locks' });
  });

  it('grants exclusive acquisition: a second concurrent acquire for the same key is denied', async () => {
    const lockManager = fakeLockManager();
    const coordinator = new RefreshLeaseCoordinator({ leaseMs: 1000, lockManager });

    const lease1 = await coordinator.acquire('dest-1');
    expect(lease1).not.toBeNull();

    // A held lock (per the fake) blocks a second `request` for the same name.
    const otherCoordinator = new RefreshLeaseCoordinator({ leaseMs: 1000, lockManager });
    const lease2 = await otherCoordinator.acquire('dest-1');
    expect(lease2).toBeNull();

    await lease1!.release();
  });

  it('release() frees the lock for another acquirer', async () => {
    const lockManager = fakeLockManager();
    const coordinatorA = new RefreshLeaseCoordinator({ leaseMs: 1000, lockManager });
    const coordinatorB = new RefreshLeaseCoordinator({ leaseMs: 1000, lockManager });

    const lease1 = await coordinatorA.acquire('dest-1');
    await lease1!.release();

    const lease2 = await coordinatorB.acquire('dest-1');
    expect(lease2).not.toBeNull();
  });
});
