import { Logger, noopLogger } from '../Logger';

/**
 * Minimal, batch-oriented durable key/value contract that both
 * `middleware/withCache.ts` (evidence persistence) and
 * `middleware/withRateLimit.ts` (own-bucket persistence, for a warm restart
 * with a stable `contextId`) hydrate from and write through to.
 *
 * Shaped after `chrome.storage.local` (get-everything, set-many,
 * remove-many) rather than a single-key `get`/`set`, because that is both
 * what the primary intended host environment (a Manifest V3 extension)
 * actually offers and what every other realistic backing store (IndexedDB,
 * an in-memory Map, localStorage) can trivially satisfy — a single-key API
 * would force every implementation to fake batching on top of one-at-a-time
 * calls instead of the other way around.
 */
export interface DurableStore {
  /** Every currently-stored key/value pair. A store shared by more than one namespace (or by both the cache and the rate limiter) returns entries belonging to all of them — callers are responsible for recognizing and ignoring keys/envelopes that aren't theirs (see {@link readEnvelope}), never for assuming everything returned belongs to them. */
  getAll(): Promise<ReadonlyMap<string, unknown>>;
  /** Writes every entry in `values`, replacing any existing value at that key. */
  setMany(values: ReadonlyMap<string, unknown>): Promise<void>;
  /** Removes every key in `keys`, if present. Removing an absent key is not an error. */
  deleteMany(keys: readonly string[]): Promise<void>;
  /** Removes every key this store manages. Only ever called on a store this object owns and was told to clear (e.g. an explicit purge tool), never automatically on a namespace/version mismatch — a mismatch quarantines just the offending keys via {@link readEnvelope} returning `undefined`, not the whole store. */
  clear(): Promise<void>;
}

/** In-memory {@link DurableStore}. Used as the default in tests and anywhere a caller wants durability semantics (namespacing, corruption handling) exercised without a real browser storage API. Data does not survive process exit — for genuine restart-safety, use {@link createChromeStorageLocalStore} or an equivalent real backing store. */
export class InMemoryDurableStore implements DurableStore {
  private readonly data = new Map<string, unknown>();

  async getAll(): Promise<ReadonlyMap<string, unknown>> {
    return new Map(this.data);
  }

  async setMany(values: ReadonlyMap<string, unknown>): Promise<void> {
    for (const [key, value] of values) this.data.set(key, value);
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

/** The subset of the `chrome.storage.local` (or `.session`) surface {@link createChromeStorageLocalStore} needs — narrowed so tests can inject a fake without pulling in `@types/chrome`. */
export interface ChromeStorageAreaLike {
  /** Matches `chrome.storage.local.get(null)`: returns every stored key/value pair in this area, not just ones this store's `keyPrefix` owns. */
  get(keys: null): Promise<Record<string, unknown>>;
  /** Matches `chrome.storage.local.set(items)`: writes every key in `items`, replacing any existing value. */
  set(items: Record<string, unknown>): Promise<void>;
  /** Matches `chrome.storage.local.remove(keys)`: removes every listed key, if present. */
  remove(keys: string[]): Promise<void>;
  /** Matches `chrome.storage.local.clear()`: removes every key in the whole area, including ones outside this store's `keyPrefix` — {@link createChromeStorageLocalStore}'s own `clear()` never calls this directly for that reason; see its implementation. */
  clear(): Promise<void>;
}

/**
 * Builds a {@link DurableStore} backed by a `chrome.storage.local`-shaped
 * area, or returns `null` if none is available — mirroring
 * `middleware/withRateLimit.ts`'s `defaultChannel` pattern of degrading to
 * "no capability" rather than throwing when a browser API a host
 * environment may not have simply isn't there (e.g. Node under Vitest, or a
 * content-script context with only `chrome.storage.session` permitted).
 *
 * All keys are namespaced under `keyPrefix` so a store area shared with
 * unrelated extension code is never read from or written to outside that
 * prefix.
 */
export function createChromeStorageLocalStore(
  keyPrefix: string,
  area: ChromeStorageAreaLike | null | undefined = defaultChromeStorageArea(),
  logger: Logger = noopLogger,
): DurableStore | null {
  if (!area) return null;
  const prefixed = (key: string): string => `${keyPrefix}:${key}`;

  return {
    async getAll(): Promise<ReadonlyMap<string, unknown>> {
      const all = await area.get(null);
      const result = new Map<string, unknown>();
      const prefix = `${keyPrefix}:`;
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(prefix)) result.set(key.slice(prefix.length), value);
      }
      return result;
    },
    async setMany(values: ReadonlyMap<string, unknown>): Promise<void> {
      const items: Record<string, unknown> = {};
      for (const [key, value] of values) items[prefixed(key)] = value;
      try {
        await area.set(items);
      } catch (err) {
        // Quota exceeded or a serialization failure: the in-memory state
        // this write was mirroring stays authoritative for this process: a
        // failed persist degrades to "not restart-safe for this entry", not
        // a thrown error the caller must handle.
        logger.warn('DurableStore.setManyFailed', { err, keyCount: values.size });
      }
    },
    async deleteMany(keys: readonly string[]): Promise<void> {
      try {
        await area.remove(keys.map(prefixed));
      } catch (err) {
        logger.warn('DurableStore.deleteManyFailed', { err, keyCount: keys.length });
      }
    },
    async clear(): Promise<void> {
      const all = await this.getAll();
      await this.deleteMany([...all.keys()]);
    },
  };
}

function defaultChromeStorageArea(): ChromeStorageAreaLike | null {
  const g = globalThis as unknown as {
    chrome?: { storage?: { local?: ChromeStorageAreaLike } };
  };
  return g.chrome?.storage?.local ?? null;
}

/**
 * Envelope every record written through a {@link DurableStore} is wrapped
 * in, so a reader can recognize and quarantine a record that predates a
 * shape change instead of trying to interpret it as the current shape.
 */
export interface DurableEnvelope<T> {
  /** Bumped whenever the shape of `value` (for this envelope's logical record type) changes incompatibly. */
  readonly schemaVersion: number;
  /** The actual persisted record, at exactly `schemaVersion`'s shape. */
  readonly value: T;
}

/** Wraps `value` in a {@link DurableEnvelope} at `schemaVersion`, ready to hand to a {@link DurableStore}'s `setMany`. */

export function wrapEnvelope<T>(schemaVersion: number, value: T): DurableEnvelope<T> {
  return { schemaVersion, value };
}

/**
 * Reads one record out of a raw value fetched from a {@link DurableStore},
 * failing closed: anything that isn't a well-formed envelope at exactly
 * `expectedSchemaVersion`, or whose `value` fails `isValue`, is treated as
 * corrupt/incompatible and quarantined (returns `undefined`) rather than
 * risking a malformed or stale-shaped record being interpreted as live
 * evidence. This is the single choke point both `withCache` and
 * `withRateLimit` route persisted reads through — "corrupt persistence
 * fails closed and is recoverable" holds because the caller's response to
 * `undefined` is always "treat as absent", never "throw" or "guess."
 */
export function readEnvelope<T>(
  raw: unknown,
  expectedSchemaVersion: number,
  isValue: (value: unknown) => value is T,
): T | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const envelope = raw as Partial<DurableEnvelope<unknown>>;
  if (envelope.schemaVersion !== expectedSchemaVersion) return undefined;
  if (!isValue(envelope.value)) return undefined;
  return envelope.value;
}
