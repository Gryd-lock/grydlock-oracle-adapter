import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFuzzer } from './fuzz/fuzzer';

/**
 * PCT-style concurrency fuzzer run against `CoalescingOracle` alone. See
 * CONCURRENCY_INVARIANTS.md (Part A, INV-CO-1/2) and
 * FUZZER_DESIGN.md (Part B) for the design and budget justification.
 */
describe('CoalescingOracle concurrency fuzzer', () => {
  it('finds zero invariant violations across 5000 randomized concurrent schedules', async () => {
    const report = await runFuzzer({
      seed: 0xc0a1e5,
      iterations: 5000,
      sutKind: 'co-only',
      minCallers: 2,
      maxCallers: 8,
      destinations: ['A', 'B'],
      depth: 2,
      drainProbability: 0.35,
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

  // Acceptance criterion: "A process.on('unhandledRejection') test proves
  // zero unhandled rejections from CoalescingOracle across the fuzzer's
  // explored schedules, not just hand-picked examples." `runSchedule`
  // already installs/removes a listener per schedule (feeding INV-CO-1),
  // but this test additionally wraps the *entire* fuzzer run in its own
  // top-level listener so there is no ambiguity about what is being proved.
  describe('process-level unhandledRejection listener wrapping the whole run', () => {
    let observed: unknown[] = [];
    const onUnhandled = (err: unknown) => observed.push(err);

    beforeEach(() => {
      observed = [];
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    it('never fires while exploring 3000 additional randomized schedules', async () => {
      const report = await runFuzzer({
        seed: 0xdeadbeef,
        iterations: 3000,
        sutKind: 'co-only',
        minCallers: 2,
        maxCallers: 10,
        destinations: ['A', 'B', 'C'],
        depth: 3,
        drainProbability: 0.5,
      });

      expect(report.failures).toHaveLength(0);
      expect(observed).toHaveLength(0);
    }, 30_000);
  });
});
