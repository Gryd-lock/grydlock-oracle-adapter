/**
 * Small deterministic seeded PRNG (mulberry32). The fuzzer must be
 * reproducible given a fixed seed, so no `Math.random()` is used anywhere
 * in tests/fuzz/.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [0, n). */
export function rngInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Picks a random element of a non-empty array. */
export function rngPick<T>(rng: Rng, items: readonly T[]): T {
  return items[rngInt(rng, items.length)];
}

/** Derives a fresh 32-bit seed from an existing RNG stream. */
export function rngSeed(rng: Rng): number {
  return Math.floor(rng() * 0xffffffff) >>> 0;
}
