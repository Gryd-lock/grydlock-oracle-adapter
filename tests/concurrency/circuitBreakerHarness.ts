import { vi } from 'vitest';
import { RiskOracle } from '../../src/RiskOracle';
import {
  CircuitBreakerConfig,
  CircuitBreakerOracle,
  CircuitBreakerState,
} from '../../src/CircuitBreakerOracle';
import { createDeferred, executeSchedule, FuzzInjectedError, Schedule } from './scheduler';
import { CallerResult, CircuitBreakerTrace } from './invariants';

const FUZZ_COOLDOWN_MS = 1000;

export const isFuzzFailure = (error: unknown): boolean => error instanceof FuzzInjectedError;

export type CircuitBreakerLike = Pick<RiskOracle, 'getScore'> & {
  getState(): CircuitBreakerState;
};

export type CircuitBreakerFactory = (
  oracle: RiskOracle,
  config: CircuitBreakerConfig,
) => CircuitBreakerLike;

export const fixedFactory: CircuitBreakerFactory = (oracle, config) =>
  new CircuitBreakerOracle(oracle, config);

/**
 * Faithful reintroduction of the pre-fix `CircuitBreakerOracle.getScore`:
 * the unsynchronized check-then-act this whole issue is about. Test-only,
 * never exported from `src/`. Used solely to prove the fuzzer (and its
 * invariant checks) actually catch the bug it was built to catch.
 */
export class BuggyCircuitBreakerOracle implements CircuitBreakerLike {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures = 0;
  private nextAttempt = 0;
  private readonly isInfraError: (error: unknown) => boolean;

  constructor(
    private readonly oracle: RiskOracle,
    private readonly config: CircuitBreakerConfig,
  ) {
    this.isInfraError = config.isInfrastructureError ?? (() => false);
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  async getScore(destination: string): Promise<number> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() >= this.nextAttempt) {
        this.state = CircuitBreakerState.HALF_OPEN;
      } else {
        return this.handleFallback(destination);
      }
    }

    try {
      const score = await this.oracle.getScore(destination);

      if (this.state === CircuitBreakerState.HALF_OPEN) {
        this.reset();
      }

      return score;
    } catch (error) {
      if (this.isInfraError(error)) {
        this.recordFailure();
        return this.handleFallback(destination, error);
      }

      if (this.state === CircuitBreakerState.HALF_OPEN) {
        this.reset();
      }

      throw error;
    }
  }

  private recordFailure(): void {
    this.failures++;
    if (
      this.failures >= this.config.failureThreshold ||
      this.state === CircuitBreakerState.HALF_OPEN
    ) {
      this.state = CircuitBreakerState.OPEN;
      this.nextAttempt = Date.now() + this.config.cooldownWindow;
    }
  }

  private reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failures = 0;
    this.nextAttempt = 0;
  }

  private async handleFallback(destination: string, originalError?: unknown): Promise<number> {
    if (this.config.fallback !== undefined) {
      if (this.config.fallback instanceof Error) {
        throw this.config.fallback;
      }
      if (typeof this.config.fallback === 'function') {
        return this.config.fallback(destination);
      }
    }
    throw originalError || new Error('Circuit Breaker is OPEN');
  }
}

/**
 * Primes `breaker` into OPEN (one synchronous infra failure, threshold 1),
 * advances fake time past the cooldown, then dispatches `schedule.numCallers`
 * concurrent `getScore` calls into the OPEN->HALF_OPEN admission window and
 * settles whichever of them actually reach the downstream oracle according
 * to `schedule`. Requires `vi.useFakeTimers()` to already be active.
 */
export async function runCircuitBreakerSchedule(
  factory: CircuitBreakerFactory,
  schedule: Schedule,
): Promise<CircuitBreakerTrace> {
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

  const breaker = factory(inner, {
    failureThreshold: 1,
    cooldownWindow: FUZZ_COOLDOWN_MS,
    isInfrastructureError: isFuzzFailure,
  });

  const primePromise = breaker.getScore(destination).catch(() => undefined);
  primingDeferred.reject(new FuzzInjectedError());
  await primePromise;

  vi.advanceTimersByTime(FUZZ_COOLDOWN_MS);

  const callerPromises = Array.from({ length: schedule.numCallers }, () =>
    breaker.getScore(destination).then(
      (value): CallerResult => ({ status: 'fulfilled', value }),
      (reason): CallerResult => ({ status: 'rejected', reason }),
    ),
  );

  // `invocationLog` is fully populated synchronously by the dispatch loop
  // above (see INV1's doc comment on CircuitBreakerOracle): whichever
  // implementation is under test, every real downstream call happens inside
  // the synchronous prefix of some caller's `getScore`, before any `await`
  // in this function yields back here.
  const activeIndices = [...invocationLog];
  await executeSchedule(schedule, schedulePool, activeIndices);

  const callerResults = await Promise.all(callerPromises);

  return {
    schedule,
    invocationLog,
    callerResults,
    finalState: breaker.getState(),
  };
}
