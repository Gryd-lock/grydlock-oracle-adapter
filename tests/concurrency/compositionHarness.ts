import { vi } from 'vitest';
import { RiskOracle } from '../../src/RiskOracle';
import {
  CircuitBreakerConfig,
  CircuitBreakerOracle,
  CircuitBreakerState,
} from '../../src/CircuitBreakerOracle';
import { CoalescingOracle } from '../../src/CoalescingOracle';
import { FallbackOracle } from '../../src/FallbackOracle';
import { createDeferred, executeSchedule, FuzzInjectedError, Schedule, tick } from './scheduler';
import { CallerResult, CompositionTrace } from './invariants';

const FUZZ_COOLDOWN_MS = 1000;
export const isFuzzFailure = (error: unknown): boolean => error instanceof FuzzInjectedError;

export interface Stack {
  oracle: RiskOracle;
  breaker: { getState(): CircuitBreakerState };
}

export type StackBuilder = (inner: RiskOracle, config: CircuitBreakerConfig) => Stack;

/** CircuitBreakerOracle outermost, CoalescingOracle innermost (wraps `inner`). */
export const CIRCUIT_BREAKER_OUTER: StackBuilder = (inner, config) => {
  const breaker = new CircuitBreakerOracle(new CoalescingOracle(inner), config);
  return { oracle: breaker, breaker };
};

/** CoalescingOracle outermost, CircuitBreakerOracle innermost (wraps `inner`). */
export const COALESCING_OUTER: StackBuilder = (inner, config) => {
  const breaker = new CircuitBreakerOracle(inner, config);
  return { oracle: new CoalescingOracle(breaker), breaker };
};

/** Same as CIRCUIT_BREAKER_OUTER, with a single-tier FallbackOracle wrapped around the whole stack. */
export const CIRCUIT_BREAKER_OUTER_WITH_FALLBACK: StackBuilder = (inner, config) => {
  const stack = CIRCUIT_BREAKER_OUTER(inner, config);
  return { oracle: new FallbackOracle([stack.oracle]), breaker: stack.breaker };
};

/** Same as COALESCING_OUTER, with a single-tier FallbackOracle wrapped around the whole stack. */
export const COALESCING_OUTER_WITH_FALLBACK: StackBuilder = (inner, config) => {
  const stack = COALESCING_OUTER(inner, config);
  return { oracle: new FallbackOracle([stack.oracle]), breaker: stack.breaker };
};

/**
 * Same admission protocol as `runCircuitBreakerSchedule` (prime OPEN with one
 * synchronous infra failure, advance past cooldown, dispatch
 * `schedule.numCallers` concurrent callers, settle whichever reach the
 * bottom `inner` mock per `schedule`), but dispatched through a full
 * `build(inner, config)` stack instead of a bare `CircuitBreakerOracle`, and
 * also collecting `process.on('unhandledRejection', ...)` events via
 * `collector` so both the herd/failure-dominance invariants and the
 * no-unhandled-rejection invariant are checked in the same run. Requires
 * `vi.useFakeTimers()` to already be active.
 */
export async function runCompositionSchedule(
  build: StackBuilder,
  schedule: Schedule,
  collector: unknown[],
): Promise<CompositionTrace> {
  const destination = 'fuzz-dest';
  let totalInvocations = 0;
  const primingDeferred = createDeferred<number>();
  const schedulePool = Array.from({ length: schedule.numCallers }, () => createDeferred<number>());
  const invocationLog: number[] = [];

  const inner: RiskOracle = {
    async getScore(): Promise<number> {
      const globalIdx = totalInvocations++;
      if (globalIdx === 0) {
        return primingDeferred.promise;
      }
      const callerIdx = globalIdx - 1;
      invocationLog.push(callerIdx);
      return schedulePool[callerIdx].promise;
    },
  };

  const stack = build(inner, {
    failureThreshold: 1,
    cooldownWindow: FUZZ_COOLDOWN_MS,
    isInfrastructureError: isFuzzFailure,
  });

  const before = collector.length;

  const primePromise = stack.oracle.getScore(destination).catch(() => undefined);
  primingDeferred.reject(new FuzzInjectedError());
  await primePromise;

  vi.advanceTimersByTime(FUZZ_COOLDOWN_MS);

  const callerPromises = Array.from({ length: schedule.numCallers }, () =>
    stack.oracle.getScore(destination).then(
      (value): CallerResult => ({ status: 'fulfilled', value }),
      (reason): CallerResult => ({ status: 'rejected', reason }),
    ),
  );

  const activeIndices = [...invocationLog];
  await executeSchedule(schedule, schedulePool, activeIndices);

  const callerResults = await Promise.all(callerPromises);

  // `vi.useFakeTimers()` also fakes `setImmediate`, so unlike the standalone
  // CoalescingOracle harness we can't wait on a real macrotask here; advance
  // the fake clock instead, which drains any pending fake immediates/timeouts
  // while still yielding to real microtasks (including Node's internal
  // unhandledRejection detection, which is engine-level and independent of
  // the faked timer globals) between each one.
  await tick(4);
  await vi.advanceTimersByTimeAsync(0);

  return {
    schedule,
    invocationLog,
    callerResults,
    finalState: stack.breaker.getState(),
    unhandledRejections: collector.slice(before),
  };
}
