import { describe, expect, it } from 'vitest';
import { runFuzzer } from './fuzz/fuzzer';

/**
 * Runs the fuzzer against both composition orders of CircuitBreakerOracle
 * and CoalescingOracle (OracleMiddleware.ts, lines 30-33, documents both as
 * meant to be stacked). See CONCURRENCY_INVARIANTS.md section 4 for
 * why the invariants are expected to survive composition either way, and
 * FUZZER_DESIGN.md section 3 for the iteration-budget reasoning.
 */
describe('CircuitBreakerOracle + CoalescingOracle composition fuzzer', () => {
  it('cb-outer(co-inner): finds zero invariant violations across 2000 schedules', async () => {
    const report = await runFuzzer({
      seed: 0x0c0f1c,
      iterations: 2000,
      sutKind: 'cb-outer-co-inner',
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
        `cb-outer-co-inner: ${report.failures.length}/${report.iterations} failing schedules. ` +
          `First: ${JSON.stringify(first.violations, null, 2)}\nSpec: ${JSON.stringify(first.spec)}`,
      );
    }
    expect(report.failures).toHaveLength(0);
  }, 30_000);

  it('co-outer(cb-inner): finds zero invariant violations across 2000 schedules', async () => {
    const report = await runFuzzer({
      seed: 0xc0ffee,
      iterations: 2000,
      sutKind: 'co-outer-cb-inner',
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
        `co-outer-cb-inner: ${report.failures.length}/${report.iterations} failing schedules. ` +
          `First: ${JSON.stringify(first.violations, null, 2)}\nSpec: ${JSON.stringify(first.spec)}`,
      );
    }
    expect(report.failures).toHaveLength(0);
  }, 30_000);
});
