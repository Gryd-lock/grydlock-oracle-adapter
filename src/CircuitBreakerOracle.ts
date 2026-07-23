import { RiskOracle } from './RiskOracle';

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownWindow: number;
  fallback?: ((destination: string) => Promise<number>) | Error;
  isInfrastructureError?: (error: unknown) => boolean;
}

export function defaultIsInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { message, name: errorName } = error as { message?: string; name?: string };
  const msg = (message || '').toLowerCase();
  const name = (errorName || '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('rpc') ||
    name.includes('timeouterror') ||
    name.includes('networkerror')
  );
}

/**
 * Circuit breaker decorator around a RiskOracle.
 *
 * # Concurrency invariants
 *
 * The full correctness argument (linearizability-style proof, the exact
 * invariants below, and how they map onto the fuzzer's assertions) lives in
 * `CONCURRENCY_INVARIANTS.md`. In short, this class maintains:
 *
 * - **INV-CB-1 (single-flight probe)**: at most one call to
 *   `this.oracle.getScore` is ever in flight while `state === HALF_OPEN`.
 * - **INV-CB-2 (atomic transition)**: the OPEN -> HALF_OPEN transition and
 *   the launch of that one probe happen in the same synchronous turn (no
 *   `await` separates the eligibility check from claiming the probe slot),
 *   so JS's run-to-completion guarantee makes the transition atomic without
 *   any explicit lock.
 * - **INV-CB-3 (deterministic settlement)**: a probe failure always wins
 *   over a concurrently-*requested* success, because there is structurally
 *   only ever one probe outcome to apply — see the doc for why this
 *   subsumes the "failure beats concurrent success" requirement.
 * - **INV-CB-4 (per-destination correctness)**: a caller for destination X
 *   never receives the resolved score of a probe launched for a different
 *   destination Y. Callers that arrive while a probe (launched by some
 *   other caller, possibly for a different destination) is in flight await
 *   *that probe's outcome* (success/failure, i.e. the resulting breaker
 *   state) and then issue their own call against the freshly-settled state,
 *   rather than reusing the probe's resolved value.
 */
export class CircuitBreakerOracle implements RiskOracle {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures: number = 0;
  private nextAttempt: number = 0;
  private readonly isInfraError: (error: unknown) => boolean;

  /**
   * The single in-flight HALF_OPEN probe, or null when no probe is running.
   * Non-null if and only if `state === HALF_OPEN` (see INV-CB-1/2 above).
   */
  private halfOpenProbe: Promise<number> | null = null;

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
      if (Date.now() < this.nextAttempt) {
        return this.handleFallback(destination);
      }

      // Cooldown elapsed: this call claims the probe slot. Everything from
      // the `state === OPEN` check above down to this point is synchronous
      // (no `await`), so exactly one concurrent caller can ever observe
      // "OPEN and cooldown elapsed" and execute this branch before the
      // mutation below flips `state` to HALF_OPEN for everyone else. See
      // INV-CB-2 in CONCURRENCY_INVARIANTS.md.
      this.state = CircuitBreakerState.HALF_OPEN;
      this.halfOpenProbe = this.runProbe(destination);
      return this.halfOpenProbe;
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Some other caller already owns the single in-flight probe (INV-CB-1).
      // Wait for it to settle so `state` reflects the outcome, then
      // re-evaluate from scratch for *this* destination rather than
      // returning the probe's value directly (INV-CB-4). The rejection (if
      // any) is intentionally swallowed here: it belongs to the probe's own
      // caller, and re-throwing an unawaited/unrelated rejection here would
      // itself be a floating-promise hazard.
      await this.halfOpenProbe!.catch(() => undefined);
      return this.getScore(destination);
    }

    try {
      const score = await this.oracle.getScore(destination);
      return score;
    } catch (error) {
      if (this.isInfraError(error)) {
        this.recordFailure();
        return this.handleFallback(destination, error);
      }

      // Non-infrastructure errors indicate the system is logically
      // reachable; nothing to do to CLOSED-state bookkeeping.
      throw error;
    }
  }

  /**
   * Executes the single HALF_OPEN probe call and applies its outcome to the
   * breaker's state. Only ever invoked once per HALF_OPEN cycle (INV-CB-1).
   */
  private async runProbe(destination: string): Promise<number> {
    try {
      const score = await this.oracle.getScore(destination);
      this.reset();
      return score;
    } catch (error) {
      if (this.isInfraError(error)) {
        this.recordFailure();
        return this.handleFallback(destination, error);
      }

      // Non-infrastructure errors indicate the system is logically
      // reachable, even though this particular probe call failed.
      this.reset();
      throw error;
    } finally {
      this.halfOpenProbe = null;
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
