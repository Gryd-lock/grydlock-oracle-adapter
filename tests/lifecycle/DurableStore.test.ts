import { describe, expect, it } from 'vitest';
import {
  ChromeStorageAreaLike,
  InMemoryDurableStore,
  createChromeStorageLocalStore,
  readEnvelope,
  wrapEnvelope,
} from '../../src/lifecycle/DurableStore';

describe('InMemoryDurableStore', () => {
  it('round-trips setMany/getAll/deleteMany/clear', async () => {
    const store = new InMemoryDurableStore();
    await store.setMany(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );

    expect(Object.fromEntries(await store.getAll())).toEqual({ a: 1, b: 2 });

    await store.deleteMany(['a']);
    expect(Object.fromEntries(await store.getAll())).toEqual({ b: 2 });

    await store.clear();
    expect((await store.getAll()).size).toBe(0);
  });

  it('deleting an absent key is not an error', async () => {
    const store = new InMemoryDurableStore();
    await expect(store.deleteMany(['nope'])).resolves.toBeUndefined();
  });
});

function fakeChromeArea(): ChromeStorageAreaLike & { backing: Record<string, unknown> } {
  const backing: Record<string, unknown> = {};
  return {
    backing,
    async get(keys: null) {
      void keys;
      return { ...backing };
    },
    async set(items: Record<string, unknown>) {
      Object.assign(backing, items);
    },
    async remove(keys: string[]) {
      for (const k of keys) delete backing[k];
    },
    async clear() {
      for (const k of Object.keys(backing)) delete backing[k];
    },
  };
}

describe('createChromeStorageLocalStore', () => {
  it('returns null when no chrome.storage.local-shaped area is available', () => {
    expect(createChromeStorageLocalStore('prefix', null)).toBeNull();
  });

  it('namespaces every key under keyPrefix, invisible to getAll callers', async () => {
    const area = fakeChromeArea();
    const store = createChromeStorageLocalStore('myprefix', area)!;

    await store.setMany(new Map([['dest-a', 42]]));

    expect(Object.keys(area.backing)).toEqual(['myprefix:dest-a']);
    expect(Object.fromEntries(await store.getAll())).toEqual({ 'dest-a': 42 });
  });

  it('getAll never returns keys belonging to a different prefix sharing the same area', async () => {
    const area = fakeChromeArea();
    area.backing['other-extension-feature:something'] = 'not mine';
    const store = createChromeStorageLocalStore('myprefix', area)!;
    await store.setMany(new Map([['dest-a', 1]]));

    const all = await store.getAll();
    expect(all.has('something')).toBe(false);
    expect(Object.fromEntries(all)).toEqual({ 'dest-a': 1 });
  });

  it('a quota/serialization failure on set is caught, not thrown', async () => {
    const area = fakeChromeArea();
    area.set = async () => {
      throw new Error('QUOTA_BYTES exceeded');
    };
    const store = createChromeStorageLocalStore('p', area)!;

    await expect(store.setMany(new Map([['a', 1]]))).resolves.toBeUndefined();
  });

  it("clear() removes only this prefix's keys", async () => {
    const area = fakeChromeArea();
    area.backing['unrelated:key'] = 1;
    const store = createChromeStorageLocalStore('mine', area)!;
    await store.setMany(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );

    await store.clear();

    expect(area.backing).toEqual({ 'unrelated:key': 1 });
  });
});

describe('readEnvelope', () => {
  const isNumber = (v: unknown): v is number => typeof v === 'number';

  it('reads a well-formed envelope at the expected schema version', () => {
    const raw = wrapEnvelope(1, 42);
    expect(readEnvelope(raw, 1, isNumber)).toBe(42);
  });

  it('quarantines (returns undefined) a mismatched schema version', () => {
    const raw = wrapEnvelope(2, 42);
    expect(readEnvelope(raw, 1, isNumber)).toBeUndefined();
  });

  it('quarantines a value that fails the shape guard', () => {
    const raw = wrapEnvelope(1, 'not a number');
    expect(readEnvelope(raw, 1, isNumber)).toBeUndefined();
  });

  it('quarantines non-object garbage rather than throwing', () => {
    expect(readEnvelope(null, 1, isNumber)).toBeUndefined();
    expect(readEnvelope(undefined, 1, isNumber)).toBeUndefined();
    expect(readEnvelope('garbage', 1, isNumber)).toBeUndefined();
    expect(readEnvelope(42, 1, isNumber)).toBeUndefined();
    expect(readEnvelope({}, 1, isNumber)).toBeUndefined();
  });
});
