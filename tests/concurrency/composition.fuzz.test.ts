import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSchedule } from './scheduler';
import { checkCompositionInvariants } from './invariants';
import {
  CIRCUIT_BREAKER_OUTER,
  CIRCUIT_BREAKER_OUTER_WITH_FALLBACK,
  COALESCING_OUTER,
  COALESCING_OUTER_WITH_FALLBACK,
  runCompositionSchedule,
  StackBuilder,
} from './compositionHarness';

// Same iteration budget as the standalone fuzzers; see CONCURRENCY_INVARIANTS.md.
const ITERATIONS = 2000;
const GEN_OPTS = { minCallers: 2, maxCallers: 5, targetDepth: 3, maxTicks: 2 } as const;

const stacks: Array<[string, StackBuilder]> = [
  ['CircuitBreakerOracle(CoalescingOracle(inner))', CIRCUIT_BREAKER_OUTER],
  ['CoalescingOracle(CircuitBreakerOracle(inner))', COALESCING_OUTER],
  [
    'FallbackOracle([CircuitBreakerOracle(CoalescingOracle(inner))])',
    CIRCUIT_BREAKER_OUTER_WITH_FALLBACK,
  ],
  [
    'FallbackOracle([CoalescingOracle(CircuitBreakerOracle(inner))])',
    COALESCING_OUTER_WITH_FALLBACK,
  ],
];

describe('CircuitBreakerOracle + CoalescingOracle composition fuzzer', () => {
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
    vi.useRealTimers();
  });

  it.each(stacks)(
    `finds zero invariant violations for %s over ${ITERATIONS} randomized schedules`,
    async (_name, build) => {
      const violationsFound: unknown[] = [];

      for (let seed = 0; seed < ITERATIONS; seed++) {
        const schedule = generateSchedule(seed, GEN_OPTS);
        const trace = await runCompositionSchedule(build, schedule, unhandledRejections);
        const violations = checkCompositionInvariants(trace);
        if (violations.length > 0) {
          violationsFound.push({ seed, violations });
        }
      }

      expect(violationsFound).toEqual([]);
      expect(unhandledRejections).toEqual([]);
    },
  );
});
