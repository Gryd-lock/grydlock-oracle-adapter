import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSchedule, Schedule, shrinkSchedule } from './scheduler';
import { checkCircuitBreakerInvariants } from './invariants';
import {
  BuggyCircuitBreakerOracle,
  CircuitBreakerFactory,
  fixedFactory,
  runCircuitBreakerSchedule,
} from './circuitBreakerHarness';

// See CONCURRENCY_INVARIANTS.md for the derivation of this budget: with
// n = maxCallers = 5, k = 5, targetDepth d = 3, PCT's bound gives
// p_min = 1/(n*k^(d-1)) = 1/125, so 2000 iterations gives
// 1 - (1 - 1/125)^2000 ≈ 1 (comfortably above the ~1147 needed for 99.99%
// confidence of finding a depth-3 bug if one exists).
const ITERATIONS = 2000;
const GEN_OPTS = { minCallers: 2, maxCallers: 5, targetDepth: 3, maxTicks: 2 } as const;

const buggyFactory: CircuitBreakerFactory = (oracle, config) =>
  new BuggyCircuitBreakerOracle(oracle, config);

async function findFirstViolation(factory: CircuitBreakerFactory, iterations: number) {
  for (let seed = 0; seed < iterations; seed++) {
    const schedule = generateSchedule(seed, GEN_OPTS);
    const trace = await runCircuitBreakerSchedule(factory, schedule);
    const violations = checkCircuitBreakerInvariants(trace);
    if (violations.length > 0) {
      return { seed, schedule, violations };
    }
  }
  return null;
}

describe('CircuitBreakerOracle concurrency fuzzer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`finds zero invariant violations in the fixed implementation over ${ITERATIONS} randomized schedules`, async () => {
    const violationsFound: unknown[] = [];

    for (let seed = 0; seed < ITERATIONS; seed++) {
      const schedule = generateSchedule(seed, GEN_OPTS);
      const trace = await runCircuitBreakerSchedule(fixedFactory, schedule);
      const violations = checkCircuitBreakerInvariants(trace);
      if (violations.length > 0) {
        violationsFound.push({ seed, violations });
      }
    }

    expect(violationsFound).toEqual([]);
  });

  it(`finds an INV violation in the reintroduced pre-fix implementation within ${ITERATIONS} schedules (proves the fuzzer is a real bug-finder)`, async () => {
    const found = await findFirstViolation(buggyFactory, ITERATIONS);

    expect(found).not.toBeNull();
    expect(found!.violations.length).toBeGreaterThan(0);
    const names = found!.violations.map((v) => v.name);
    expect(names.some((n) => /^INV[123]_/.test(n))).toBe(true);
  });

  it('shrinks a failing schedule against the buggy implementation to a strictly smaller reproducer', async () => {
    const found = await findFirstViolation(buggyFactory, ITERATIONS);
    expect(found).not.toBeNull();

    const reproduces = async (candidate: Schedule): Promise<boolean> => {
      const trace = await runCircuitBreakerSchedule(buggyFactory, candidate);
      return checkCircuitBreakerInvariants(trace).length > 0;
    };

    const shrunk = await shrinkSchedule(found!.schedule, reproduces);

    expect(shrunk.finalSize).toBeLessThan(shrunk.originalSize);
    expect(shrunk.schedule.numCallers).toBeLessThanOrEqual(found!.schedule.numCallers);
    expect(await reproduces(shrunk.schedule)).toBe(true);
  });
});
