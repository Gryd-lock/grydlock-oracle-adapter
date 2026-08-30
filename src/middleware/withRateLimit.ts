import { RiskOracle } from '../RiskOracle';
import { OracleMiddleware } from '../OracleMiddleware';
import { Logger, noopLogger } from '../Logger';
import { Disposable } from '../lifecycle/Disposable';
import { DurableStore, readEnvelope, wrapEnvelope } from '../lifecycle/DurableStore';

/** Current gossip wire-protocol version. Bumped whenever `GossipMessage`'s shape changes incompatibly; a message at any other version is dropped rather than misparsed. */
const GOSSIP_PROTOCOL_VERSION = 1;
const OWN_BUCKETS_SCHEMA_VERSION = 1;
const RATE_LIMIT_KEY_PREFIX = 'rate-limit';

/** Structured detail attached to every {@link OracleRateLimitError}. */
export interface RateLimitDenialDetails {
  /** The configured combined budget. */
  budget: number;
  /** The configured sliding window length, in milliseconds. */
  windowMs: number;
  /** The denying context's own id. */
  contextId: string;
  /** This context's CRDT-merged estimate of the combined admitted count, at denial time. */
  globalEstimate: number;
  /** This context's fair-share cap (`ceil(budget / knownContextCount)`) at denial time. */
  fairShare: number;
  /** This context's own admitted count within the current window, at denial time. */
  selfCount: number;
  /** Which of the two admission checks (see the module doc) denied the request. */
  reason: 'global-budget' | 'fair-share';
}

/** Thrown by {@link withRateLimit} when a request is denied by either the
 * cross-context global budget check or this context's own fair-share cap. */
export class OracleRateLimitError extends Error {
  constructor(
    destination: string,
    /** Structured context explaining why this specific request was denied. */
    public readonly details: RateLimitDenialDetails,
  ) {
    super(
      `getScore("${destination}") denied by rate limiter: ${details.reason} ` +
        `(global estimate ${details.globalEstimate}/${details.budget}, ` +
        `context ${details.contextId} self ${details.selfCount}/${details.fairShare})`,
    );
    this.name = 'OracleRateLimitError';
  }
}

/** The minimal shape this middleware needs from a message-bus channel — the
 * subset of the DOM `BroadcastChannel` interface it actually uses, so tests
 * can inject a fake implementing just this. */
export interface BroadcastChannelLike {
  /** Sends `message` to every other channel instance sharing this channel's name. */
  postMessage(message: unknown): void;
  /** Registers a handler invoked for every message received from another instance. */
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  /** Removes a handler previously passed to {@link addEventListener}. */
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  /** Releases any resources held by this channel instance. */
  close?(): void;
}

/** Construction options for {@link withRateLimit}. */
export interface RateLimitOptions {
  /** Max requests admitted, combined across every context sharing this
   * channel, within any trailing `windowMs` window. */
  budget: number;
  /** Sliding window length, in milliseconds, the budget applies over. */
  windowMs: number;
  /**
   * Minimum time, in milliseconds, between this context's own gossip
   * broadcasts (a trailing-edge throttle driven by call activity, not a
   * timer — see the module doc for why). Defaults to `windowMs / 10`,
   * clamped to `[250, windowMs]`.
   */
  gossipIntervalMs?: number;
  /**
   * Sliding-window bucket granularity, in milliseconds. Defaults to
   * `gossipIntervalMs`. Smaller buckets track the window boundary more
   * precisely at the cost of more buckets to merge/prune; must evenly
   * relate to `windowMs` only loosely — any positive value works.
   */
  bucketMs?: number;
  /**
   * `BroadcastChannel` name used to discover other contexts. Ignored if
   * `channel` is explicitly supplied. Defaults to
   * `"grydlock-oracle-adapter:rate-limit"`.
   */
  channelName?: string;
  /**
   * Injectable channel, for tests or environments with a non-global
   * `BroadcastChannel`. Defaults to `new BroadcastChannel(channelName)` if
   * the global `BroadcastChannel` constructor exists. Pass `null` (or leave
   * unset in an environment with no global `BroadcastChannel`, e.g. Node
   * under Vitest) to run in local-only mode: no gossip is sent or received,
   * and the limiter behaves as a plain single-context token bucket — see
   * "Degrading to single-context behavior" in the module doc.
   */
  channel?: BroadcastChannelLike | null;
  /**
   * Stable identifier for this context's own counter slot in the CRDT. Two
   * `withRateLimit` instances sharing a channel MUST use different
   * `contextId`s, or their admissions will be merged as one context's,
   * defeating the global budget. Defaults to a random id generated once per
   * `withRateLimit(...)` call.
   */
  contextId?: string;
  /** Clock returning epoch milliseconds. Injectable for tests. */
  now?: () => number;
  /** Logger for gossip send/receive failures. Defaults to the no-op logger. */
  logger?: Logger;
  /**
   * Upper bound on distinct contexts tracked at once (own context always
   * counts as one of these and is never evicted). Bounds memory against a
   * flood of forged `contextId`s: once exceeded, the least-recently-updated
   * non-self context is dropped to make room, exactly like natural staleness
   * pruning would eventually do anyway. Defaults to 256.
   */
  maxTrackedContexts?: number;
  /** Maximum accepted `contextId` length in a received gossip message. Defaults to 128. */
  maxContextIdLength?: number;
  /** Maximum accepted number of bucket entries in a single received gossip message. Defaults to `4 * bucketsPerWindow` (generous slack for clock skew, still bounded). */
  maxBucketsPerMessage?: number;
  /**
   * Durable store for this context's own admitted-count buckets, so a warm
   * restart of the *same* context doesn't get a silently-reset budget
   * mid-window ("restart cannot ... silently unleash full traffic").
   * Requires a stable, caller-supplied `contextId` — a randomly generated
   * one can never be found again after a restart, so persistence with no
   * explicit `contextId` is accepted but has nothing to hydrate from.
   */
  store?: DurableStore;
}

interface GossipMessage {
  type: 'grydlock-oracle-adapter:rate-limit-gossip';
  /** Wire-protocol version — see {@link GOSSIP_PROTOCOL_VERSION}. A message at any other version is dropped, not best-effort-parsed. */
  version: number;
  contextId: string;
  /** bucketIndex (as a string, for JSON/structured-clone-object-key safety) -> admitted count. */
  buckets: Record<string, number>;
}

interface PersistedOwnBuckets {
  contextId: string;
  /** bucketIndex (as a string) -> admitted count. */
  buckets: Record<string, number>;
}

/** Result of {@link RateLimitedRiskOracle.getCoordinationStatus}. */
export interface RateLimitCoordinationStatus {
  /** `'coordinated'`: a gossip channel is live, so `budget` is (best-effort) shared across every known context. `'local-only'`: no channel is available, so `budget` is enforced purely against this instance's own admissions — see {@link withRateLimit}'s "Degrading to single-context behavior". */
  mode: 'coordinated' | 'local-only';
  /** Number of distinct contexts (including this one) currently tracked, per `withRateLimit`'s module doc's "Bounded memory" section. */
  knownContextCount: number;
}

/** What {@link withRateLimit} hands back: a plain `RiskOracle` plus disposal and degraded-mode introspection. */
export interface RateLimitedRiskOracle extends RiskOracle, Disposable {
  /** Reports whether this instance can currently coordinate a shared budget across contexts, or is enforcing `budget` purely against its own admissions — see {@link withRateLimit}'s "Degrading to single-context behavior". */
  getCoordinationStatus(): RateLimitCoordinationStatus;
}

function isPersistedOwnBuckets(value: unknown): value is PersistedOwnBuckets {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.contextId === 'string' && typeof v.buckets === 'object' && v.buckets !== null;
}

function randomContextId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID (older runtimes).
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultChannel(channelName: string): BroadcastChannelLike | null {
  const g = globalThis as unknown as {
    BroadcastChannel?: new (name: string) => BroadcastChannelLike;
  };
  if (typeof g.BroadcastChannel !== 'function') return null;
  return new g.BroadcastChannel(channelName);
}

/** One context's bucketIndex -> admitted-count view. */
export type BucketMap = ReadonlyMap<number, number>;

/**
 * The CRDT join (merge) for a single context's bucket map: pointwise max,
 * the G-Counter merge operation. Exported as a standalone pure function so
 * it can be property-tested directly — both the live gossip-merge path
 * below and `tests/withRateLimit.crdt-properties.test.ts` call this exact
 * function, so proving its properties here proves them for the deployed
 * behavior, not a separate spec written to match it.
 *
 * Commutative and associative because pointwise `max` is; idempotent
 * because `max(x, x) = x`. Never mutates either input.
 */
export function joinBucketMaps(a: BucketMap, b: BucketMap): BucketMap {
  const merged = new Map<number, number>();
  for (const [bucket, count] of a) {
    if (count >= 0) merged.set(bucket, count);
  }
  for (const [bucket, count] of b) {
    if (count < 0) continue;
    const existing = merged.get(bucket) ?? 0;
    if (count > existing || !merged.has(bucket)) merged.set(bucket, count);
  }
  return merged;
}

function isGossipMessage(data: unknown): data is GossipMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === 'grydlock-oracle-adapter:rate-limit-gossip' &&
    d.version === GOSSIP_PROTOCOL_VERSION &&
    typeof d.contextId === 'string' &&
    typeof d.buckets === 'object' &&
    d.buckets !== null
  );
}

/**
 * Cross-context, gossip-coordinated rate limit (issue #73), built on the
 * shared middleware abstraction (#46). Bounds the *combined* outgoing
 * `getScore` rate across every JS context that composes this middleware onto
 * the same `BroadcastChannel` — a single browser-extension "client" is often
 * several independent realms (a Manifest V3 background service worker plus
 * one or more content-script contexts) with no shared memory and no
 * synchronous coordination primitive.
 *
 * ## Why a CRDT, and which one
 *
 * The design space (see the issue's hints) is roughly: (a) a leader-elected
 * coordinator holding the real budget, (b) generous fixed per-context
 * sub-budgets with no coordination at all, or (c) a CRDT-merged approximate
 * shared view. This implements (c), specifically a **G-Counter (grow-only
 * counter) CRDT, indexed by (contextId, time-bucket)** rather than a single
 * scalar per replica:
 *
 * - **Why not (a), leader election:** `BroadcastChannel` gives no consensus
 *   primitive, and a Manifest V3 service worker can be suspended and woken
 *   at any time — a "leader" context can vanish silently mid-term with no
 *   way for the others to detect that synchronously. Leader election under
 *   these constraints needs its own failure-detection/re-election protocol,
 *   which is strictly more machinery than the problem needs, and every
 *   design still has to answer "what does a context do while leaderless?" —
 *   which is exactly what the gossip-CRDT answers directly.
 * - **Why not (b), generous static sub-budgets with no coordination:**
 *   simplest to implement, but it either wastes most of the budget (each of
 *   `N` contexts capped at `budget/N_max` for some assumed worst-case
 *   `N_max`, even when only one context is actually active) or is unsafe
 *   (no cap at all, or a cap sized for the common case that a burst of new
 *   contexts blows through). It also cannot satisfy "exact single-context
 *   behavior when alone" (acceptance criterion) without *knowing* it's
 *   alone, which requires the very discovery mechanism gossip provides.
 * - **Why a G-Counter over a PN-Counter:** admitted-request counts within a
 *   bucket only ever go up during that bucket's life — there is no
 *   "decrement" event, only expiry (handled by dropping old buckets, not by
 *   subtracting). A PN-Counter's negative half would be dead weight.
 * - **Why bucketed instead of one scalar per replica:** a single ever-
 *   growing per-replica counter can't express a *sliding* window (you'd
 *   only ever be able to ask "how many total, ever", not "how many in the
 *   last `windowMs`"). Bucketing by time turns "prune" into "drop old
 *   buckets", which is also what keeps memory bounded (see below) — an
 *   un-bucketed G-Counter would have to be reset out-of-band and could never
 *   forget stale contexts.
 *
 * ## CRDT structure and merge
 *
 * State is `Map<contextId, Map<bucketIndex, count>>`. Only a context's own
 * `contextId` slot is ever written locally (on an admitted request); every
 * other slot is populated purely by merging received gossip. `bucketIndex`
 * is `floor(t / bucketMs)`. Merging an incoming `(contextId, bucketIndex,
 * count)` triple takes the pointwise max against any existing value for that
 * key. Because a context's own bucket count is monotonically
 * non-decreasing for the bucket's lifetime, pointwise max is:
 *
 * - **idempotent** — merging the same message twice changes nothing after
 *   the first time (`max(x, x) = x`), so duplicate delivery is harmless.
 * - **commutative** — `max(max(a,b),c) = max(a,max(b,c))` for any arrival
 *   order, so out-of-order or repeated delivery converges to the same state.
 * - **associative** — merges can be batched/replayed in any grouping with
 *   the same result.
 *
 * These three properties (the definition of a state-based CRDT) are what
 * make "no message ordering or delivery guarantee" survivable at all —
 * `tests/withRateLimit.crdt-properties.test.ts` proves them directly via
 * randomized merge-order trials, not just "it seemed to work."
 *
 * ## Admission rule (two independent checks, both must pass)
 *
 * 1. **Global estimate check:** `sum(all known contexts' in-window buckets)
 *    + 1 <= budget`. This is the CRDT-merged approximate view of the shared
 *    budget.
 * 2. **Local fair-share check:** `thisContext's own in-window count + 1 <=
 *    ceil(budget / knownContextCount)`, where `knownContextCount` is the
 *    number of distinct contextIds currently tracked (always >= 1, since a
 *    context always knows about itself). This is a purely local invariant —
 *    it does not require receiving anything — and is what gives the design
 *    a provable bound even under total gossip loss (see below), and what
 *    makes the single-context case exact: with no gossip partners ever
 *    observed, `knownContextCount` stays `1` forever, so the fair-share cap
 *    equals `budget` and check 2 never restricts anything the global check
 *    (which, with no other contexts, is tracking exactly this context's own
 *    count) doesn't already enforce — i.e. it degenerates to exactly a
 *    single-process sliding-window counter, not an approximation of one.
 *
 * ## The overshoot bound
 *
 * There are two bounds worth stating, because they answer two different
 * questions: "what's the absolute worst case, no matter what?" and "what
 * does gossip actually buy us once it's working?"
 *
 * **Bound 1 — unconditional, provable by construction, no assumptions about
 * `BroadcastChannel` delivery at all:**
 *
 * ```
 * combined admissions in any trailing window  <=  N * budget
 * ```
 *
 * where `N` is the number of contexts that admitted at least one request in
 * that window. This follows directly from check 1 alone, with no help from
 * check 2 and no assumption that any gossip ever arrives: check 1 requires
 * `estimate + 1 <= budget` before every admission, and `estimate` always
 * includes this context's own count (it's a sum over all known contexts,
 * including itself) — so `estimate >= ownCount` always, which means every
 * individual context's own admitted count, within its own view of any
 * trailing window, never exceeds `budget`, *purely from checking its own
 * arithmetic against its own (possibly totally isolated) state*. Summing
 * `N` individually-bounded contexts gives `N * budget`. This is what makes
 * the overshoot *provably bounded* even in the fundamental worst case: two
 * contexts permanently, totally partitioned from each other (every message
 * between them lost forever) each correctly and independently cap
 * themselves at `budget` — neither can silently become unbounded, they just
 * fail to *share* the budget, which is the best any purely-gossip-based
 * design can guarantee when delivery isn't guaranteed at all (proving
 * anything tighter than this would require a delivery guarantee
 * `BroadcastChannel` does not provide).
 * `tests/withRateLimit.adversarial-gossip.test.ts` asserts this bound as a
 * hard invariant — it must hold on every one of 200+ randomized adversarial
 * runs, since it's true by construction regardless of loss/reorder/duplication.
 *
 * **Bound 2 — the design's actual payoff, once gossip is working:** once
 * every pair of active contexts has exchanged at least one message (rosters
 * converged), check 2's fair-share cap (`ceil(budget / knownContextCount)`)
 * additionally restricts each context, tightening the combined bound to
 *
 * ```
 * budget + N   (pure ceil() rounding slop: N contexts each independently
 *              capped at ceil(budget/N) over-count budget by at most N-1
 *              when summed)
 * ```
 *
 * This is *why* the gossip/CRDT machinery exists at all — without it, every
 * context would only ever have bound 1 (`N * budget`) available to it, with
 * no way to safely tighten to a fair split even when peers are perfectly
 * reachable. `tests/withRateLimit.adversarial-gossip.test.ts` checks this
 * one as an empirical, convergence-dependent expectation (comfortably
 * loose, to stay non-flaky under randomized loss) rather than a hard
 * per-run invariant like bound 1, and demonstrates it separately for a
 * lossless control run vs. lossy/reordered/duplicated runs.
 *
 * ## Why throttled-eager broadcast instead of `setInterval`
 *
 * A naive periodic timer stops firing the instant a Manifest V3 service
 * worker context is suspended — exactly the failure mode the issue calls
 * out — and a suspended timer fails silently (no error, just stale gossip).
 * Instead, this middleware broadcasts its own updated bucket state
 * immediately after an admission, but at most once per `gossipIntervalMs`
 * (a trailing-edge throttle keyed off the injectable clock, not a running
 * timer). A context with no new admissions has nothing new to say and isn't
 * running a timer to say it with; a context that resumes after suspension
 * broadcasts on its very next admission, catching peers up without waiting
 * out an unrelated fixed period. This also makes the whole middleware
 * driven entirely by `getScore` calls plus inbound messages — no
 * `setInterval`/`setTimeout` to fake, mock, or leak in tests.
 *
 * ## Bounded memory (issue constraint: O(1) amortized, bounded regardless
 * of lifetime message count)
 *
 * Every `getScore` call first drops buckets older than `windowMs` from
 * every tracked context, and drops a context entirely once it has zero
 * remaining buckets (except this context's own slot, which is never
 * dropped so local admission always has somewhere to record). State size is
 * therefore bounded by `(currently-or-recently-active context count) ×
 * ceil(windowMs / bucketMs)`, independent of how many gossip messages have
 * ever been received over the process's lifetime — a context that stops
 * broadcasting (closed tab, permanently suspended worker) ages out of every
 * peer's state within one window, not never.
 *
 * ## Degrading to single-context behavior
 *
 * If no `BroadcastChannel` is available (`channel` is `null`/unset and the
 * global `BroadcastChannel` constructor doesn't exist — e.g. Node under
 * Vitest with no polyfill), no gossip is sent or received; `knownContextCount`
 * is permanently `1`. Both admission checks then operate purely on this
 * context's own count against the full `budget`, over the same sliding
 * window — an exact, not approximate, single-process sliding-window rate
 * limiter, verified directly in
 * `tests/withRateLimit.single-context.test.ts` against a from-scratch
 * baseline implementation.
 */
export function withRateLimit(
  options: RateLimitOptions,
): OracleMiddleware<RiskOracle, RateLimitedRiskOracle> {
  const {
    budget,
    windowMs,
    gossipIntervalMs = Math.min(Math.max(windowMs / 10, 250), windowMs),
    bucketMs = gossipIntervalMs,
    channelName = 'grydlock-oracle-adapter:rate-limit',
    contextId = randomContextId(),
    now = Date.now,
    logger = noopLogger,
    maxTrackedContexts = 256,
    maxContextIdLength = 128,
    store,
  } = options;

  if (!Number.isFinite(budget) || budget <= 0) {
    throw new RangeError(`withRateLimit: budget must be a positive number, got ${budget}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`withRateLimit: windowMs must be a positive number, got ${windowMs}`);
  }
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new RangeError(`withRateLimit: bucketMs must be a positive number, got ${bucketMs}`);
  }

  const bucketsPerWindow = Math.max(1, Math.ceil(windowMs / bucketMs));
  const maxBucketsPerMessage = options.maxBucketsPerMessage ?? 4 * bucketsPerWindow;

  // Ownership: a channel this factory call default-constructs is ours to
  // close on dispose(); one the caller explicitly supplied (even
  // `undefined`, which is why `'channel' in options` is checked rather than
  // `options.channel === undefined`) is never closed here — see
  // `lifecycle/Disposable.ts`'s ownership rule.
  const channelSupplied = Object.prototype.hasOwnProperty.call(options, 'channel');
  const channel = channelSupplied ? (options.channel ?? null) : defaultChannel(channelName);
  const ownsChannel = !channelSupplied;

  return (next: RiskOracle): RateLimitedRiskOracle => {
    const counters = new Map<string, Map<number, number>>();
    counters.set(contextId, new Map());
    const lastSeenAt = new Map<string, number>(); // non-self contextId -> last time we recorded/merged something for it, for LRU eviction under maxTrackedContexts
    let disposed = false;

    let lastBroadcastAt = -Infinity;
    let hydrated: Promise<void> | undefined;

    function ownStorageKey(): string {
      return `${RATE_LIMIT_KEY_PREFIX}::${channelName}::${contextId}`;
    }

    function persistOwn(): void {
      if (!store) return;
      const own = counters.get(contextId);
      if (!own) return;
      const buckets: Record<string, number> = {};
      for (const [b, c] of own) buckets[String(b)] = c;
      const record: PersistedOwnBuckets = { contextId, buckets };
      store
        .setMany(new Map([[ownStorageKey(), wrapEnvelope(OWN_BUCKETS_SCHEMA_VERSION, record)]]))
        .catch((err: unknown) => logger.warn('withRateLimit.persistFailed', { err, contextId }));
    }

    /**
     * Restores this context's own admitted-count buckets from `store`, if
     * any — so a warm restart with the *same* stable `contextId` resumes
     * mid-window instead of getting a fresh, silently-larger effective
     * budget for the remainder of that window ("restart cannot ... silently
     * unleash full traffic"). A record for a different `contextId` (or a
     * caller that never set one and got a fresh random one) simply isn't
     * found, which is the correct behavior for a genuinely new identity.
     */
    function ensureHydrated(): Promise<void> {
      if (!store) return Promise.resolve();
      if (!hydrated) {
        hydrated = (async () => {
          let raw: unknown;
          try {
            const all = await store.getAll();
            raw = all.get(ownStorageKey());
          } catch (err) {
            logger.warn('withRateLimit.hydrationReadFailed', { err, contextId });
            return;
          }
          const record = readEnvelope(raw, OWN_BUCKETS_SCHEMA_VERSION, isPersistedOwnBuckets);
          if (record === undefined || record.contextId !== contextId) return;
          const own = ensureContext(contextId);
          for (const [bucketKey, count] of Object.entries(record.buckets)) {
            const b = Number(bucketKey);
            if (Number.isFinite(b) && Number.isFinite(count) && count >= 0) own.set(b, count);
          }
          pruneStale(now());
        })();
      }
      return hydrated;
    }

    function bucketIndexAt(t: number): number {
      return Math.floor(t / bucketMs);
    }

    /** Drops the least-recently-*seen* (per `lastSeenAt`) non-self context to
     * make room, when a brand-new context would push `counters` past
     * `maxTrackedContexts`. Bounds memory against a flood of distinct
     * forged `contextId`s independent of natural bucket-staleness pruning,
     * which only ever removes a context once every one of its buckets has
     * aged out — an attacker sending one bucket per forged id per window
     * would otherwise never trigger that path. */
    function evictLeastRecentlySeenContext(): void {
      let oldestCid: string | undefined;
      let oldestSeenAt = Number.POSITIVE_INFINITY;
      for (const [cid, seenAt] of lastSeenAt) {
        if (seenAt < oldestSeenAt) {
          oldestSeenAt = seenAt;
          oldestCid = cid;
        }
      }
      const victim = oldestCid ?? [...counters.keys()].find((cid) => cid !== contextId);
      if (victim !== undefined) {
        counters.delete(victim);
        lastSeenAt.delete(victim);
      }
    }

    function ensureContext(cid: string): Map<number, number> {
      let buckets = counters.get(cid);
      if (buckets === undefined) {
        if (cid !== contextId && counters.size >= maxTrackedContexts) {
          evictLeastRecentlySeenContext();
        }
        buckets = new Map();
        counters.set(cid, buckets);
      }
      return buckets;
    }

    /** Drops buckets outside the current sliding window, and any non-self
     * context left with no remaining buckets. Bounds memory (see module doc). */
    function pruneStale(t: number): void {
      const minBucket = bucketIndexAt(t) - bucketsPerWindow + 1;
      for (const [cid, buckets] of counters) {
        for (const b of buckets.keys()) {
          if (b < minBucket) buckets.delete(b);
        }
        if (buckets.size === 0 && cid !== contextId) {
          counters.delete(cid);
          lastSeenAt.delete(cid);
        }
      }
    }

    function sumBuckets(buckets: Map<number, number>): number {
      let sum = 0;
      for (const c of buckets.values()) sum += c;
      return sum;
    }

    function globalEstimate(): number {
      let sum = 0;
      for (const buckets of counters.values()) sum += sumBuckets(buckets);
      return sum;
    }

    function selfCount(): number {
      return sumBuckets(counters.get(contextId) as Map<number, number>);
    }

    /**
     * Validates and merges one received gossip message. Hardened against a
     * malicious or buggy peer beyond the original shape check
     * (`isGossipMessage`, which only confirms wire-level shape): an
     * implausible `contextId` (empty or absurdly long) or an oversized
     * bucket map is dropped in full rather than partially trusted, and any
     * individual bucket entry whose index is further than a bounded
     * tolerance from this context's own clock is dropped as forged/skewed —
     * so neither a flood of distinct fake identities nor a single message
     * full of nonsense buckets can inflate `globalEstimate()` or grow state
     * without bound (see `maxTrackedContexts`/`evictLeastRecentlySeenContext`
     * for the identity-flood bound specifically).
     */
    function mergeGossip(msg: GossipMessage): void {
      if (msg.contextId === contextId) return; // never let a self-echo overwrite local truth
      if (msg.contextId.length === 0 || msg.contextId.length > maxContextIdLength) return;

      const bucketEntries = Object.entries(msg.buckets);
      if (bucketEntries.length > maxBucketsPerMessage) return;

      const nowBucket = bucketIndexAt(now());
      const skewToleranceBuckets = bucketsPerWindow * 8; // generous but bounded tolerance for clock skew/late delivery
      const incoming = new Map<number, number>();
      for (const [bucketKey, count] of bucketEntries) {
        const b = Number(bucketKey);
        if (!Number.isFinite(b) || !Number.isFinite(count) || count < 0) continue; // malformed entry
        if (Math.abs(b - nowBucket) > skewToleranceBuckets) continue; // implausible bucket: forged/skewed clock
        incoming.set(b, count);
      }
      const existing = ensureContext(msg.contextId);
      counters.set(msg.contextId, new Map(joinBucketMaps(existing, incoming)));
      lastSeenAt.set(msg.contextId, now());
    }

    function broadcastOwnState(t: number): void {
      if (!channel) return;
      const own = counters.get(contextId) as Map<number, number>;
      const buckets: Record<string, number> = {};
      for (const [b, c] of own) buckets[String(b)] = c;
      const msg: GossipMessage = {
        type: 'grydlock-oracle-adapter:rate-limit-gossip',
        version: GOSSIP_PROTOCOL_VERSION,
        contextId,
        buckets,
      };
      try {
        channel.postMessage(msg);
        lastBroadcastAt = t;
      } catch (err) {
        logger.warn('withRateLimit.broadcastFailed', { err, contextId });
      }
    }

    const messageListener = channel
      ? (event: { data: unknown }): void => {
          try {
            if (isGossipMessage(event.data)) {
              mergeGossip(event.data);
              // Prune here too, not only inside getScore: a context that
              // receives gossip but is never itself called would otherwise
              // accumulate unboundedly with call volume never triggering a
              // cleanup (see module doc, "Bounded memory").
              pruneStale(now());
            }
          } catch (err) {
            logger.warn('withRateLimit.gossipHandlingFailed', { err, contextId });
          }
        }
      : undefined;

    if (channel && messageListener) {
      channel.addEventListener('message', messageListener);
    }

    return {
      /**
       * Whether this instance can actually coordinate a shared budget with
       * other contexts right now. `'local-only'` means exactly what
       * `withRateLimit`'s module doc's "Degrading to single-context
       * behavior" section says: this instance enforces `budget` against
       * only its own admissions, with no claim of a strict *global* quota
       * (non-negotiable invariant: degraded coordination is visible and
       * never claims strict global enforcement it can't back up).
       */
      getCoordinationStatus(): RateLimitCoordinationStatus {
        return {
          mode: channel ? 'coordinated' : 'local-only',
          knownContextCount: counters.size,
        };
      },
      /**
       * Idempotent. Removes this instance's own gossip listener always; closes
       * the channel only if this `withRateLimit(...)` call default-constructed
       * it (`ownsChannel`) — a caller-supplied channel is never closed here,
       * per `Disposable`'s ownership rule.
       */
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        if (channel && messageListener) {
          channel.removeEventListener?.('message', messageListener);
        }
        if (channel && ownsChannel) {
          channel.close?.();
        }
        counters.clear();
        lastSeenAt.clear();
      },
      async getScore(destination: string): Promise<number> {
        if (disposed) {
          throw new Error('withRateLimit: getScore called after dispose()');
        }
        await ensureHydrated();

        const t = now();
        pruneStale(t);

        const estimate = globalEstimate();
        if (estimate + 1 > budget) {
          throw new OracleRateLimitError(destination, {
            budget,
            windowMs,
            contextId,
            globalEstimate: estimate,
            fairShare: Math.ceil(budget / counters.size),
            selfCount: selfCount(),
            reason: 'global-budget',
          });
        }

        const knownContextCount = counters.size; // always >= 1 (self)
        const fairShare = Math.ceil(budget / knownContextCount);
        const self = selfCount();
        if (self + 1 > fairShare) {
          throw new OracleRateLimitError(destination, {
            budget,
            windowMs,
            contextId,
            globalEstimate: estimate,
            fairShare,
            selfCount: self,
            reason: 'fair-share',
          });
        }

        const own = counters.get(contextId) as Map<number, number>;
        const b = bucketIndexAt(t);
        own.set(b, (own.get(b) ?? 0) + 1);
        persistOwn();

        if (t - lastBroadcastAt >= gossipIntervalMs) {
          broadcastOwnState(t);
        }

        return next.getScore(destination);
      },
    };
  };
}
