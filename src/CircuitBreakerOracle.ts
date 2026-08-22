import { RiskOracle } from './RiskOracle';
import { CancellableRiskOracle, isCancellable, raceWithCancellation } from './CancellableRiskOracle';
import { OracleCancelledError } from './OracleError';

/** Lifecycle state of a {@link CircuitBreakerOracle}. */
export enum CircuitBreakerState {
  /** Normal operation: every call is passed through to the wrapped oracle. */
  CLOSED = 'CLOSED',
  /** Tripped: calls short-circuit to the configured fallback (or throw) until the cooldown elapses. */
  OPEN = 'OPEN',
  /** Cooldown elapsed: exactly one probe call is admitted to test whether the oracle recovered. */
  HALF_OPEN = 'HALF_OPEN',
}

/** Construction options for {@link CircuitBreakerOracle}. */
export interface CircuitBreakerConfig {
  /** Number of infrastructure failures that trips the breaker to OPEN. */
  failureThreshold: number;
  /** Milliseconds the breaker stays OPEN before allowing a HALF_OPEN probe. */
  cooldownWindow: number;
  /** Value or producer served while OPEN; if omitted, the original failure is rethrown. */
  fallback?: ((destination: string) => Promise<number>) | Error;
  /** Classifies an error as infrastructure-related (counts toward the threshold). Defaults to {@link defaultIsInfrastructureError}. */
  isInfrastructureError?: (error: unknown) => boolean;
}

/** Default infrastructure-error classifier: matches network/timeout/RPC-flavored messages and error names. */
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
 *
 * ## Cancellation (issue #98)
 *
 * `getScoreCancellable`'s CLOSED-state path genuinely owns its underlying
 * call (mirroring plain `getScore`'s CLOSED path), so a caller cancelling
 * there actually frees the resource. The HALF_OPEN probe is different: it
 * is the single shared resource INV-CB-1 exists to protect, and it may be
 * awaited by several callers (the one that claimed the slot and any later
 * arrivals) — no single caller cancelling is allowed to tear it down out
 * from under the others. So a caller's own cancellation while claiming or
 * waiting on the probe only unblocks *that caller* early with
 * `OracleCancelledError`; the probe itself (and `runProbe`) is unchanged
 * and keeps running to completion, still driving the breaker's state
 * transition from its real outcome. A cancelled CLOSED-path call is never
 * recorded as an infrastructure failure — see the `OracleCancelledError`
 * check before `isInfraError` below.
 */
export class CircuitBreakerOracle implements RiskOracle, CancellableRiskOracle {
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

  /** @returns The breaker's current {@link CircuitBreakerState}. */
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

    // CLOSED: each call is independent; no probe admission/coalescing applies.
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
   * Cancellable counterpart to {@link getScore} — see the class doc's
   * "Cancellation" section for what is and isn't actually abortable here.
   */
  public async getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
    if (signal.aborted) {
      throw new OracleCancelledError('The oracle request was cancelled.', { destination });
    }

    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        return raceWithCancellation(this.handleFallback(destination), signal, destination);
      }

      // Same synchronous claim as getScore's OPEN branch (INV-CB-2): no
      // await between the eligibility check and this mutation.
      this.state = CircuitBreakerState.HALF_OPEN;
      this.halfOpenProbe = this.runProbe(destination);
      return raceWithCancellation(this.halfOpenProbe, signal, destination);
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      await raceWithCancellation(this.halfOpenProbe!.catch(() => undefined), signal, destination);
      return this.getScoreCancellable(destination, signal);
    }

    // CLOSED: this call genuinely owns its underlying request, so
    // cancellation here actually frees the resource rather than merely
    // detaching interest.
    try {
      const score = isCancellable(this.oracle)
        ? await this.oracle.getScoreCancellable(destination, signal)
        : await raceWithCancellation(this.oracle.getScore(destination), signal, destination);
      return score;
    } catch (error) {
      if (error instanceof OracleCancelledError) {
        throw error;
      }
      if (this.isInfraError(error)) {
        this.recordFailure();
        return this.handleFallback(destination, error);
      }
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
