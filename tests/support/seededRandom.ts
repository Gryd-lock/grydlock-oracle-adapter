/**
 * A tiny seeded PRNG (mulberry32) for adversarial/property tests that need
 * many randomized trials to be *reproducible* on failure — a raw
 * `Math.random()` failure in a 200+-trial adversarial simulation would be
 * nearly impossible to reproduce and debug. Not cryptographic; test-only.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
