import { RiskOracle } from '../../src/RiskOracle';
import {
  CircuitBreakerConfig,
  CircuitBreakerState,
  defaultIsInfrastructureError,
} from '../../src/CircuitBreakerOracle';
import { Logger, noopLogger } from '../../src/Logger';
import { ManualOracle } from './manualOracle';
import {
  Harness,
  SpyCall,
  spyOn,
  instrumentGeneration,
  GenerationTracker,
  DEFAULT_CB_CONFIG,
} from './harness';

/**
 * Test-only reintroduction of the pre-fix `CircuitBreakerOracle`: an
 * unsynchronized check-then-act on `this.state`. Concurrent callers that
 * both observe `OPEN && cooldown elapsed` both flip to HALF_OPEN and both
 * call the downstream oracle — the thundering herd this issue is about.
 * Exists solely so the fuzzer's bug-finding ability can be demonstrated
 * against a known-bad implementation (see tests/fuzz.selfcheck.test.ts).
 */
export class BuggyCircuitBreakerOracle implements RiskOracle {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures = 0;
  private nextAttempt = 0;
  private readonly isInfraError: (error: unknown) => boolean;

  constructor(
    private readonly oracle: RiskOracle,
    private readonly config: CircuitBreakerConfig,
  ) {
    this.isInfraError = config.isInfrastructureError || defaultIsInfrastructureError;
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public async getScore(destination: string): Promise<number> {
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
 * Test-only reintroduction of the pre-fix `CoalescingOracle` bug: a
 * floating `p.catch(err => { ...; throw err; })` whose returned promise is
 * discarded, never awaited, and never given a rejection handler — a
 * textbook `unhandledRejection` leak. Exists solely to demonstrate the
 * fuzzer catches it.
 */
export class BuggyCoalescingOracle implements RiskOracle {
  private readonly inFlightByDestination = new Map<string, Promise<number>>();

  constructor(
    private readonly inner: RiskOracle,
    private readonly logger: Logger = noopLogger,
  ) {}

  async getScore(destination: string): Promise<number> {
    const existing = this.inFlightByDestination.get(destination);
    if (existing) return existing;

    const p = this.inner.getScore(destination);
    this.inFlightByDestination.set(destination, p);

    p.finally(() => {
      if (this.inFlightByDestination.get(destination) === p) {
        this.inFlightByDestination.delete(destination);
      }
    });

    // The bug: this floating promise is never awaited or stored, and its
    // handler rethrows, so *this* promise (not `p`) rejects unobserved.
    p.catch((err) => {
      this.logger.warn('CoalescingOracle.innerFailed', { destination, err });
      throw err;
    });

    return p;
  }
}

export function buildBuggyCbHarness(cbConfig: Partial<CircuitBreakerConfig> = {}): Harness {
  const manual = new ManualOracle();
  const spyCalls: SpyCall[] = [];
  const config: CircuitBreakerConfig = { ...DEFAULT_CB_CONFIG, ...cbConfig };
  const box: { current: GenerationTracker | null } = { current: null };
  const spied = spyOn(manual, spyCalls, {
    getState: () => box.current!.getState(),
    getGeneration: () => box.current!.getGeneration(),
  });
  const cb = new BuggyCircuitBreakerOracle(spied, config);
  box.current = instrumentGeneration(cb);
  return {
    kind: 'cb-only',
    sut: cb,
    manual,
    // `cb`/`co` are typed against the real classes elsewhere; the buggy
    // stand-ins only need to satisfy RiskOracle plus (for cb) getState(),
    // which InvariantChecks read structurally.
    cb: cb as unknown as Harness['cb'],
    co: null,
    spyCalls,
    callLog: () => manual.callLog,
    transitions: box.current.transitions,
  };
}

export function buildBuggyCoHarness(): Harness {
  const manual = new ManualOracle();
  const spyCalls: SpyCall[] = [];
  const spied = spyOn(manual, spyCalls, null);
  const co = new BuggyCoalescingOracle(spied);
  return {
    kind: 'co-only',
    sut: co,
    manual,
    cb: null,
    co: co as unknown as Harness['co'],
    spyCalls,
    callLog: () => manual.callLog,
    transitions: [],
  };
}
