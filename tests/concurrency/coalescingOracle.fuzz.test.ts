import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSchedule, Schedule, shrinkSchedule } from './scheduler';
import { checkCoalescingInvariants } from './invariants';
import {
  BuggyCoalescingOracle,
  CoalescingFactory,
  fixedFactory,
  runCoalescingSchedule,
} from './coalescingHarness';

// Same iteration-budget justification as the CircuitBreaker fuzzer (see
// CONCURRENCY_INVARIANTS.md): 2000 randomized schedules per scenario.
const ITERATIONS = 2000;
const GEN_OPTS = { minCallers: 2, maxCallers: 6, targetDepth: 3, maxTicks: 2 } as const;

const buggyFactory: CoalescingFactory = (inner) => new BuggyCoalescingOracle(inner);

describe('CoalescingOracle concurrency fuzzer', () => {
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(() => {
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  it(`produces zero unhandled rejections and consistent settlement over ${ITERATIONS} randomized schedules`, async () => {
    const violationsFound: unknown[] = [];

    for (let seed = 0; seed < ITERATIONS; seed++) {
      const schedule = generateSchedule(seed, GEN_OPTS);
      const trace = await runCoalescingSchedule(fixedFactory, schedule, unhandledRejections);
      const violations = checkCoalescingInvariants(trace);
      if (violations.length > 0) {
        violationsFound.push({ seed, violations });
      }
    }

    expect(violationsFound).toEqual([]);
    expect(unhandledRejections).toEqual([]);
  });

  it(`finds an unhandled-rejection violation in the reintroduced pre-fix implementation within ${ITERATIONS} schedules`, async () => {
    let found: { seed: number; schedule: Schedule } | null = null;

    for (let seed = 0; seed < ITERATIONS && !found; seed++) {
      const schedule = generateSchedule(seed, GEN_OPTS);
      const trace = await runCoalescingSchedule(buggyFactory, schedule, unhandledRejections);
      const violations = checkCoalescingInvariants(trace);
      const hasUnhandledRejection = violations.some((v) => v.name === 'INV_NO_UNHANDLED_REJECTION');
      if (hasUnhandledRejection) {
        found = { seed, schedule };
      }
    }

    expect(found).not.toBeNull();
  });

  it('shrinks a failing schedule against the buggy implementation to a strictly smaller reproducer', async () => {
    let found: Schedule | null = null;

    for (let seed = 0; seed < ITERATIONS && !found; seed++) {
      const schedule = generateSchedule(seed, GEN_OPTS);
      const trace = await runCoalescingSchedule(buggyFactory, schedule, unhandledRejections);
      const violations = checkCoalescingInvariants(trace);
      if (violations.some((v) => v.name === 'INV_NO_UNHANDLED_REJECTION')) {
        found = schedule;
      }
    }
    expect(found).not.toBeNull();

    const reproduces = async (candidate: Schedule): Promise<boolean> => {
      const localCollector: unknown[] = [];
      const localHandler = (reason: unknown): void => {
        localCollector.push(reason);
      };
      process.on('unhandledRejection', localHandler);
      try {
        const trace = await runCoalescingSchedule(buggyFactory, candidate, localCollector);
        return checkCoalescingInvariants(trace).some(
          (v) => v.name === 'INV_NO_UNHANDLED_REJECTION',
        );
      } finally {
        process.off('unhandledRejection', localHandler);
      }
    };

    const shrunk = await shrinkSchedule(found!, reproduces);

    expect(shrunk.finalSize).toBeLessThan(shrunk.originalSize);
    expect(await reproduces(shrunk.schedule)).toBe(true);
  });
});
