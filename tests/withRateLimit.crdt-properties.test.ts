/**
 * Property-based verification that `joinBucketMaps` — the G-Counter merge
 * `withRateLimit` uses for every gossip message it receives (issue #73) — is
 * actually commutative, associative, and idempotent, across many randomized
 * trials, rather than merely "seems to work" on a couple of hand-picked
 * examples. These are the three properties that define a state-based CRDT;
 * without them, "no message ordering or delivery guarantee" would not be
 * survivable.
 *
 * This tests `joinBucketMaps` directly (not through `getScore`/gossip
 * plumbing) because it's the exact function the live merge path calls — see
 * its doc comment in `src/middleware/withRateLimit.ts`.
 */
import { describe, expect, it } from 'vitest';
import { BucketMap, joinBucketMaps } from '../src/middleware/withRateLimit';
import { seededRandom } from './support/seededRandom';

function randomBucketMap(random: () => number, maxBuckets: number, maxCount: number): BucketMap {
  const size = Math.floor(random() * (maxBuckets + 1));
  const map = new Map<number, number>();
  for (let i = 0; i < size; i++) {
    const bucket = Math.floor(random() * maxBuckets * 2); // some overlap, some not
    const count = Math.floor(random() * (maxCount + 1));
    map.set(bucket, count);
  }
  return map;
}

function bucketMapsEqual(a: BucketMap, b: BucketMap): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

function describeBucketMap(m: BucketMap): string {
  return JSON.stringify(Object.fromEntries([...m.entries()].sort((x, y) => x[0] - y[0])));
}

const TRIALS = 3000;

describe('property: joinBucketMaps is idempotent', () => {
  it('join(a, a) === a for randomized maps', () => {
    const random = seededRandom(1);
    for (let trial = 0; trial < TRIALS; trial++) {
      const a = randomBucketMap(random, 8, 50);
      const result = joinBucketMaps(a, a);
      expect(
        bucketMapsEqual(result, a),
        `trial ${trial}: a=${describeBucketMap(a)}, join(a,a)=${describeBucketMap(result)}`,
      ).toBe(true);
    }
  });

  it('joining an already-merged result again changes nothing', () => {
    const random = seededRandom(2);
    for (let trial = 0; trial < TRIALS; trial++) {
      const a = randomBucketMap(random, 8, 50);
      const b = randomBucketMap(random, 8, 50);
      const once = joinBucketMaps(a, b);
      const twice = joinBucketMaps(once, b);
      expect(
        bucketMapsEqual(once, twice),
        `trial ${trial}: a=${describeBucketMap(a)}, b=${describeBucketMap(b)}`,
      ).toBe(true);
    }
  });
});

describe('property: joinBucketMaps is commutative', () => {
  it('join(a, b) === join(b, a) for randomized maps', () => {
    const random = seededRandom(3);
    for (let trial = 0; trial < TRIALS; trial++) {
      const a = randomBucketMap(random, 8, 50);
      const b = randomBucketMap(random, 8, 50);
      const ab = joinBucketMaps(a, b);
      const ba = joinBucketMaps(b, a);
      expect(
        bucketMapsEqual(ab, ba),
        `trial ${trial}: a=${describeBucketMap(a)}, b=${describeBucketMap(b)}`,
      ).toBe(true);
    }
  });
});

describe('property: joinBucketMaps is associative', () => {
  it('join(join(a, b), c) === join(a, join(b, c)) for randomized maps', () => {
    const random = seededRandom(4);
    for (let trial = 0; trial < TRIALS; trial++) {
      const a = randomBucketMap(random, 6, 50);
      const b = randomBucketMap(random, 6, 50);
      const c = randomBucketMap(random, 6, 50);
      const left = joinBucketMaps(joinBucketMaps(a, b), c);
      const right = joinBucketMaps(a, joinBucketMaps(b, c));
      expect(
        bucketMapsEqual(left, right),
        `trial ${trial}: a=${describeBucketMap(a)}, b=${describeBucketMap(b)}, c=${describeBucketMap(c)}`,
      ).toBe(true);
    }
  });
});

describe('property: merging a random sequence of updates converges to the same state regardless of merge order', () => {
  it('holds for randomized sequences of 2-10 updates, each merged in several random orders', () => {
    const random = seededRandom(5);
    const SEQUENCES = 500;
    const ORDERS_PER_SEQUENCE = 6;

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const updateCount = 2 + Math.floor(random() * 9); // 2..10
      const updates: BucketMap[] = Array.from({ length: updateCount }, () =>
        randomBucketMap(random, 5, 20),
      );

      // Canonical order: left-to-right fold.
      const canonical = updates.reduce<BucketMap>(
        (acc, u) => joinBucketMaps(acc, u),
        new Map<number, number>(),
      );

      for (let orderTrial = 0; orderTrial < ORDERS_PER_SEQUENCE; orderTrial++) {
        // Fisher-Yates shuffle of the same updates.
        const shuffled = updates.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const merged = shuffled.reduce<BucketMap>(
          (acc, u) => joinBucketMaps(acc, u),
          new Map<number, number>(),
        );

        expect(
          bucketMapsEqual(merged, canonical),
          `sequence ${seq}, order ${orderTrial}: updates=${updates.map(describeBucketMap).join(' | ')}, ` +
            `shuffled order=${shuffled.map(describeBucketMap).join(' | ')}`,
        ).toBe(true);
      }
    }
  });

  it('also converges when some updates in the sequence are exact duplicates (idempotence under replay)', () => {
    const random = seededRandom(6);
    const SEQUENCES = 300;

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const base: BucketMap[] = Array.from(
        { length: 2 + Math.floor(random() * 4) },
        () => randomBucketMap(random, 5, 20),
      );
      // Build a sequence that repeats each base update a random number of times.
      const withDuplicates: BucketMap[] = [];
      for (const u of base) {
        const repeats = 1 + Math.floor(random() * 3);
        for (let r = 0; r < repeats; r++) withDuplicates.push(u);
      }
      // Shuffle.
      for (let i = withDuplicates.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [withDuplicates[i], withDuplicates[j]] = [withDuplicates[j], withDuplicates[i]];
      }

      const withoutDuplicates = base.reduce<BucketMap>(
        (acc, u) => joinBucketMaps(acc, u),
        new Map<number, number>(),
      );
      const withDuplicatesMerged = withDuplicates.reduce<BucketMap>(
        (acc, u) => joinBucketMaps(acc, u),
        new Map<number, number>(),
      );

      expect(
        bucketMapsEqual(withDuplicatesMerged, withoutDuplicates),
        `sequence ${seq}: base=${base.map(describeBucketMap).join(' | ')}`,
      ).toBe(true);
    }
  });
});
