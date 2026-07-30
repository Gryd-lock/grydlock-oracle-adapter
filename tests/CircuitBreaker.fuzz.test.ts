import { describe, expect, it } from 'vitest';
import { runFuzzer } from './fuzz/fuzzer';

/**
 * PCT-style concurrency fuzzer run against `CircuitBreakerOracle` alone.
 * See CONCURRENCY_INVARIANTS.md (Part A) for what INV-CB-* mean and
 * FUZZER_DESIGN.md (Part B) for why 5,000 iterations at depth 2 is a
 * meaningful budget. `tests/fuzz.selfcheck.test.ts` proves this same fuzzer
 * finds the original bug when pointed at the pre-fix implementation.
 */
describe('CircuitBreakerOracle concurrency fuzzer', () => {
  it('finds zero invariant violations across 5000 randomized concurrent schedules', async () => {
    const report = await runFuzzer({
      seed: 0xcb00d5,
      iterations: 5000,
      sutKind: 'cb-only',
      minCallers: 2,
      maxCallers: 6,
      destinations: ['A', 'B', 'C'],
      depth: 2,
      drainProbability: 0.3,
      warmupFailures: 2,
      cbConfig: { failureThreshold: 2, cooldownWindow: 0 },
    });

    if (report.failures.length > 0) {
      const first = report.failures[0];
      throw new Error(
        `Fuzzer found ${report.failures.length}/${report.iterations} failing schedules. ` +
          `First failure at iteration ${first.iteration}: ${JSON.stringify(first.violations, null, 2)}\n` +
          `Reproducing spec: ${JSON.stringify(first.spec)}`,
      );
    }

    expect(report.failures).toHaveLength(0);
  }, 30_000);
});
