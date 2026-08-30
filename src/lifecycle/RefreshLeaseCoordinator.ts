import { BroadcastChannelLike } from '../middleware/withRateLimit';
import { Logger, noopLogger } from '../Logger';
import { Disposable } from './Disposable';

/**
 * Bounded cross-context mutual exclusion for "who gets to run this
 * refresh", used by `withCache`'s stale-while-revalidate path (Epic
 * requirement C) so that N tabs/workers sharing one cache namespace
 * converge on a single in-flight revalidation per destination instead of
 * each independently deciding to refetch.
 *
 * ## Two coordination strategies, chosen automatically
 *
 * 1. **Web Locks API** (`navigator.locks`), when available: exact mutual
 *    exclusion with no protocol of our own to get wrong, and — the property
 *    that matters most here — the platform itself releases a held lock the
 *    instant its holding context is destroyed (tab closed, worker killed or
 *    suspended), which is a strictly better and *faster* answer to "what
 *    happens when the lease owner dies" than any timeout this module could
 *    invent. This is the preferred path whenever it exists.
 * 2. **Gossip fallback** (`BroadcastChannelLike`), when Web Locks isn't
 *    available (Node/Vitest, or a very old runtime): a bounded, best-effort
 *    ticket scheme modeled on Lamport's bakery algorithm — every claimant
 *    broadcasts a `(timestamp, contextId)` ticket, waits one bounded
 *    arbitration window for competing tickets to arrive, and only the
 *    claimant holding the lexicographically smallest ticket at the end of
 *    that window proceeds. This does not have Web Locks' hard exclusion
 *    guarantee under adversarial message loss (see the non-negotiable
 *    invariant: degraded coordination must never claim strict enforcement)
 *    — but under normal delivery it converges on exactly one winner, and an
 *    owner that goes silent (suspended/killed without sending `release`) is
 *    recovered from after `leaseMs`, not never (see `expiresAt` below).
 *
 * Both strategies expose the same `acquire`/handle shape so `withCache`
 * doesn't need to know which one is active — it only sees "did I get the
 * lease" and, if so, a `release()` to call when the refresh finishes.
 *
 * ## Bounded state regardless of adversarial input
 *
 * The gossip fallback bounds memory two ways: a fixed cap on the number of
 * distinct keys tracked at once (`maxTrackedKeys`, oldest evicted first),
 * and per-message validation (bounded `contextId` length, a plausible
 * ticket timestamp within `clockSkewToleranceMs` of this context's own
 * clock) that drops anything else rather than recording it — a forged flood
 * of distinct keys or absurd timestamps cannot grow state without bound or
 * poison arbitration for a legitimate key.
 */
export interface LeaseHandle {
  /** Releases the lease immediately, letting another context claim it right away instead of waiting out `leaseMs`. Idempotent. */
  release(): Promise<void>;
}

/** Result of {@link RefreshLeaseCoordinator.getCoordinationStatus}. */
export interface CoordinationStatus {
  /** `'web-locks'`: exact cross-context exclusion via the Web Locks API. `'gossip'`: best-effort, bounded-window exclusion over a `BroadcastChannel`-shaped channel (see the class doc's degraded-coordination caveat). `'local-only'`: no cross-context coordination is possible at all — every `acquire()` succeeds locally with no exclusion claimed. */
  mode: 'web-locks' | 'gossip' | 'local-only';
}

/** Construction options for {@link RefreshLeaseCoordinator}. */
export interface RefreshLeaseCoordinatorOptions {
  /** How long an acquired lease is valid before it's considered abandoned and eligible for another claimant, absent an explicit `release()`. This is the bound in "killing the lease owner permits recovery after a bounded timeout." */
  leaseMs: number;
  /**
   * How long the gossip fallback waits, after broadcasting its own ticket,
   * before deciding whether it won the arbitration for a key. Ignored when
   * Web Locks is in use (exact exclusion needs no window). Defaults to
   * `Math.min(50, leaseMs / 4)`.
   */
  arbitrationWindowMs?: number;
  /** Injectable Web Locks-shaped manager. `undefined` auto-detects `navigator.locks`; pass `null` to force the gossip fallback (e.g. in tests). */
  lockManager?: LockManagerLike | null;
  /** Gossip channel for the fallback strategy. `null` (the default if Web Locks is unavailable and no channel is supplied) means no cross-context coordination is possible at all: every `acquire` call succeeds locally with no exclusion — callers must treat this the same as "local-only" mode elsewhere in this package. */
  channel?: BroadcastChannelLike | null;
  /** Whether this coordinator created `channel` itself (and must close it on dispose) or received it from the caller (must not close it — see `Disposable`'s ownership rule). Defaults to `false` (assume caller-owned) when `channel` is explicitly supplied, `true` when this coordinator constructed its own default channel. */
  ownsChannel?: boolean;
  /** Stable identity for this context's tickets. Defaults to a random id — fine for tie-breaking, but note a random id also means this context's own prior tickets are never recognizable across a restart, which is irrelevant here since leases don't need restart continuity (unlike the rate limiter's own bucket). */
  contextId?: string;
  /** Upper bound on distinct keys tracked at once (bounds memory against a flood of distinct forged keys). Defaults to 500. */
  maxTrackedKeys?: number;
  /** Maximum accepted `contextId` length in a received message. Defaults to 128. */
  maxContextIdLength?: number;
  /** A received ticket timestamp further than this from this context's own clock (either direction) is dropped as implausible/forged. Defaults to `leaseMs * 4`. */
  clockSkewToleranceMs?: number;
  /** Clock returning epoch milliseconds. Injectable for tests. */
  now?: () => number;
  /** Logger for broadcast/message-handling/Web-Locks failures. Defaults to the no-op logger. */
  logger?: Logger;
}

/** The subset of the Web Locks API this module needs. */
export interface LockManagerLike {
  /** Matches `navigator.locks.request`: requests the named lock, invoking `callback` with the lock (or `null`, since only `ifAvailable: true` is ever passed here) once available; the lock is held for as long as `callback`'s returned promise stays pending. */
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

interface GossipTicket {
  type: 'grydlock-oracle-adapter:lease-request';
  key: string;
  ticket: string;
  contextId: string;
}

interface GossipConfirm {
  type: 'grydlock-oracle-adapter:lease-confirm';
  key: string;
  contextId: string;
  expiresAt: number;
}

interface GossipRelease {
  type: 'grydlock-oracle-adapter:lease-release';
  key: string;
  contextId: string;
}

type GossipMessage = GossipTicket | GossipConfirm | GossipRelease;

interface KeyState {
  /** Confirmed owner, if any, and when its lease expires. */
  confirmed?: { contextId: string; expiresAt: number };
  /** Tickets seen (including our own) for a key currently under arbitration. */
  pendingTickets: Map<string, string>; // contextId -> ticket
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function detectLockManager(): LockManagerLike | null {
  const g = globalThis as unknown as { navigator?: { locks?: LockManagerLike } };
  return g.navigator?.locks ?? null;
}

function defaultChannel(): { channel: BroadcastChannelLike | null; owned: boolean } {
  const g = globalThis as unknown as {
    BroadcastChannel?: new (name: string) => BroadcastChannelLike;
  };
  if (typeof g.BroadcastChannel !== 'function') return { channel: null, owned: false };
  return { channel: new g.BroadcastChannel('grydlock-oracle-adapter:refresh-lease'), owned: true };
}

function randomId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  return `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class RefreshLeaseCoordinator implements Disposable {
  private readonly leaseMs: number;
  private readonly arbitrationWindowMs: number;
  private readonly lockManager: LockManagerLike | null;
  private readonly channel: BroadcastChannelLike | null;
  private readonly ownsChannel: boolean;
  private readonly contextId: string;
  private readonly maxTrackedKeys: number;
  private readonly maxContextIdLength: number;
  private readonly clockSkewToleranceMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  private readonly states = new Map<string, KeyState>();
  /** De-dupes concurrent `acquire` calls for the same key from *this* context onto one in-flight arbitration — see the module doc's "50 requests / 5 contexts / 1 lease" scenario. */
  private readonly inFlightAcquire = new Map<string, Promise<LeaseHandle | null>>();
  private readonly messageListener?: (event: { data: unknown }) => void;
  private disposed = false;

  constructor(options: RefreshLeaseCoordinatorOptions) {
    this.leaseMs = options.leaseMs;
    this.arbitrationWindowMs = options.arbitrationWindowMs ?? Math.min(50, this.leaseMs / 4);
    this.lockManager =
      options.lockManager === undefined ? detectLockManager() : options.lockManager;
    this.contextId = options.contextId ?? randomId();
    this.maxTrackedKeys = options.maxTrackedKeys ?? 500;
    this.maxContextIdLength = options.maxContextIdLength ?? 128;
    this.clockSkewToleranceMs = options.clockSkewToleranceMs ?? this.leaseMs * 4;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;

    if (this.lockManager) {
      // Web Locks handles everything; no gossip channel needed at all.
      this.channel = null;
      this.ownsChannel = false;
      return;
    }

    if (options.channel !== undefined) {
      this.channel = options.channel;
      this.ownsChannel = options.ownsChannel ?? false;
    } else {
      const created = defaultChannel();
      this.channel = created.channel;
      this.ownsChannel = created.owned;
    }

    if (this.channel) {
      this.messageListener = (event) => this.handleMessage(event.data);
      this.channel.addEventListener('message', this.messageListener);
    }
  }

  /** Whether this coordinator can actually exclude across contexts right now (Web Locks, or a live gossip channel) versus operating purely locally. Mirrors `withRateLimit`'s degraded-mode reporting — a caller must not assume cross-context exclusion when this is `false`. */
  getCoordinationStatus(): CoordinationStatus {
    if (this.lockManager) return { mode: 'web-locks' };
    if (this.channel) return { mode: 'gossip' };
    return { mode: 'local-only' };
  }

  /**
   * Attempts to acquire the refresh lease for `key`. Resolves to `null` if
   * some other context already holds it (the caller should skip its own
   * refresh and rely on the holder), or a {@link LeaseHandle} if this
   * context now owns it (the caller should run its refresh, then call
   * `release()` when done rather than waiting out the full `leaseMs`).
   */
  async acquire(key: string): Promise<LeaseHandle | null> {
    if (this.disposed) return null;

    const existing = this.inFlightAcquire.get(key);
    if (existing) return existing;

    const attempt = this.doAcquire(key).finally(() => {
      if (this.inFlightAcquire.get(key) === attempt) this.inFlightAcquire.delete(key);
    });
    this.inFlightAcquire.set(key, attempt);
    return attempt;
  }

  private async doAcquire(key: string): Promise<LeaseHandle | null> {
    if (this.lockManager) return this.acquireViaWebLocks(key);
    if (this.channel) return this.acquireViaGossip(key);
    // Local-only: nothing to coordinate with, so this context always "wins"
    // its own attempts. A same-process double-refresh is still prevented by
    // the caller's own single-flight tracking (withCache's `revalidating`
    // set) — this coordinator only ever adds cross-context exclusion.
    return { release: async () => {} };
  }

  private async acquireViaWebLocks(key: string): Promise<LeaseHandle | null> {
    const lockManager = this.lockManager!;
    let releaseFn: (() => void) | undefined;
    let requestSettled: Promise<void> = Promise.resolve();
    const acquired = await new Promise<boolean>((resolveAcquired) => {
      requestSettled = lockManager
        .request(this.lockName(key), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (lock === null) {
            resolveAcquired(false);
            return;
          }
          // Hold the lock open until the caller releases the handle: the
          // callback's returned promise is what keeps a Web Lock held, so
          // we park it on a promise this coordinator resolves from
          // `release()`.
          await new Promise<void>((releaseLock) => {
            releaseFn = releaseLock;
            resolveAcquired(true);
          });
        })
        .catch((err: unknown) => {
          this.logger.warn('RefreshLeaseCoordinator.webLocksFailed', { err, key });
          resolveAcquired(false);
        })
        .then(() => undefined);
    });

    if (!acquired) return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        releaseFn?.();
        // Wait for the underlying `request()` call to actually finish
        // unwinding (the real lock is released at that point), so a caller
        // awaiting `release()` can safely assume another context can now
        // acquire the same key — not just that this handle's own bookkeeping
        // decided to let go.
        await requestSettled;
      },
    };
  }

  private lockName(key: string): string {
    return `grydlock-oracle-adapter:refresh-lease:${key}`;
  }

  private acquireViaGossip(key: string): Promise<LeaseHandle | null> {
    return new Promise((resolve) => {
      const t0 = this.now();
      const state = this.ensureState(key);

      if (state.confirmed && state.confirmed.expiresAt > t0) {
        resolve(null); // someone else already holds a live lease
        return;
      }
      if (state.confirmed && state.confirmed.expiresAt <= t0) {
        state.confirmed = undefined; // bounded recovery: expired owner, up for grabs
      }

      const ticket = `${String(t0).padStart(15, '0')}-${this.contextId}`;
      state.pendingTickets.set(this.contextId, ticket);
      this.broadcast({
        type: 'grydlock-oracle-adapter:lease-request',
        key,
        ticket,
        contextId: this.contextId,
      });

      setTimeout(() => {
        resolve(this.resolveArbitration(key, ticket));
      }, this.arbitrationWindowMs);
    });
  }

  private resolveArbitration(key: string, ownTicket: string): LeaseHandle | null {
    const state = this.states.get(key);
    if (!state) return null; // disposed mid-flight

    if (state.confirmed && state.confirmed.expiresAt > this.now()) {
      // Someone else's confirm arrived during the window; concede.
      state.pendingTickets.delete(this.contextId);
      return null;
    }

    const lowestTicket = [...state.pendingTickets.values()].sort()[0];
    state.pendingTickets.clear();

    if (lowestTicket !== ownTicket) {
      return null; // another context's ticket sorted lower: it wins
    }

    const expiresAt = this.now() + this.leaseMs;
    state.confirmed = { contextId: this.contextId, expiresAt };
    this.broadcast({
      type: 'grydlock-oracle-adapter:lease-confirm',
      key,
      contextId: this.contextId,
      expiresAt,
    });

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const s = this.states.get(key);
        if (s?.confirmed?.contextId === this.contextId) s.confirmed = undefined;
        this.broadcast({
          type: 'grydlock-oracle-adapter:lease-release',
          key,
          contextId: this.contextId,
        });
      },
    };
  }

  private ensureState(key: string): KeyState {
    let state = this.states.get(key);
    if (state === undefined) {
      if (this.states.size >= this.maxTrackedKeys) {
        const oldestKey = this.states.keys().next().value as string | undefined;
        if (oldestKey !== undefined) this.states.delete(oldestKey);
      }
      state = { pendingTickets: new Map() };
      this.states.set(key, state);
    }
    return state;
  }

  private broadcast(message: GossipMessage): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage(message);
    } catch (err) {
      this.logger.warn('RefreshLeaseCoordinator.broadcastFailed', { err, message });
    }
  }

  private handleMessage(data: unknown): void {
    try {
      if (!isPlainRecord(data) || typeof data.type !== 'string') return;
      if (typeof data.contextId !== 'string' || data.contextId.length > this.maxContextIdLength)
        return;
      if (data.contextId === this.contextId) return; // never trust a self-echo
      if (typeof data.key !== 'string') return;

      switch (data.type) {
        case 'grydlock-oracle-adapter:lease-request': {
          if (typeof data.ticket !== 'string' || data.ticket.length > this.maxContextIdLength + 32)
            return;
          const ts = Number(data.ticket.split('-')[0]);
          if (!Number.isFinite(ts) || Math.abs(ts - this.now()) > this.clockSkewToleranceMs) return;
          const state = this.ensureState(data.key);
          state.pendingTickets.set(data.contextId, data.ticket);
          return;
        }
        case 'grydlock-oracle-adapter:lease-confirm': {
          if (typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) return;
          if (data.expiresAt - this.now() > this.leaseMs * 2) return; // implausible lease length: ignore
          const state = this.ensureState(data.key);
          state.confirmed = { contextId: data.contextId, expiresAt: data.expiresAt };
          state.pendingTickets.clear();
          return;
        }
        case 'grydlock-oracle-adapter:lease-release': {
          const state = this.states.get(data.key);
          if (state?.confirmed?.contextId === data.contextId) state.confirmed = undefined;
          return;
        }
        default:
          return;
      }
    } catch (err) {
      this.logger.warn('RefreshLeaseCoordinator.messageHandlingFailed', { err });
    }
  }

  /** Idempotent. Removes this coordinator's own listener; closes the gossip channel only if this coordinator created it (see `ownsChannel`) — a caller-supplied channel is never closed here. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.states.clear();
    this.inFlightAcquire.clear();
    if (this.channel && this.messageListener) {
      this.channel.removeEventListener?.('message', this.messageListener);
    }
    if (this.channel && this.ownsChannel) {
      this.channel.close?.();
    }
  }
}
