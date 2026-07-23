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
 * ## Concurrency invariants (written correctness argument)
 *
 * This class has exactly one shared mutable state machine (`state`, `failures`,
 * `nextAttempt`, `halfOpenProbe`) accessed by however many concurrent `getScore`
 * calls happen to be in flight. There is no external lock, mutex, or `Atomics`
 * use anywhere in this file. The argument below is why that is still safe.
 *
 * ### Ground rule: synchronous blocks are atomic
 *
 * JavaScript's event loop runs each synchronous stretch of code to completion
 * before running any other callback/microtask. Two `getScore` calls can only
 * "interleave" at an `await` point — i.e. wherever one call suspends, control
 * can pass to another call's continuation, but never in the middle of a
 * sequence of statements that contains no `await`. Every read-then-write of
 * `state` / `failures` / `nextAttempt` / `halfOpenProbe` in this file happens
 * inside such an uninterrupted synchronous stretch (no `await` between the
 * read and the write). Consequently every individual state transition below
 * is atomic with respect to every other `getScore` call, with no explicit
 * lock required — this is the mechanism the invariants below rely on.
 *
 * ### INV1 — At most one in-flight probe (no thundering herd)
 *
 * At any instant, at most one call into the wrapped `oracle.getScore` is
 * outstanding as a result of a HALF_OPEN admission decision made by *this*
 * instance. Concretely: across one "OPEN episode" (the span from the moment
 * some caller observes `state === OPEN && Date.now() >= nextAttempt` until
 * the resulting probe settles), exactly one call reaches `this.oracle.getScore`.
 * Every other caller that arrives while that probe is outstanding is admitted
 * as a *coalesced* caller: it never calls the wrapped oracle itself, and
 * instead receives (resolves/rejects with) the exact same outcome as the one
 * real probe. This holds because the admission check
 * (`state === OPEN && time elapsed` → set `state = HALF_OPEN` and start
 * `halfOpenProbe`) and the coalescing check (`state === HALF_OPEN` → return
 * the existing `halfOpenProbe`) are both synchronous, uninterrupted
 * read-modify-write sequences on `state`/`halfOpenProbe` (ground rule above),
 * so however many calls arrive "simultaneously" (i.e. before any of them has
 * awaited anything), they still execute this admission logic one at a time,
 * in some order, and only the first one to run can find `halfOpenProbe`
 * still `null`.
 *
 * ### INV2 — Deterministic settlement; failure dominates a concurrent success
 *
 * Because of INV1, a HALF_OPEN episode has exactly one real outcome (the
 * single probe's resolution or rejection), and every coalesced caller for
 * that episode observes *that same* outcome — there is no separate "second
 * success" or "second failure" for the same episode that could race the
 * first. The breaker's resulting state is a pure function of that one
 * outcome: probe succeeds → `CLOSED` (failures reset); probe throws an
 * infrastructure error → `OPEN` with a fresh `nextAttempt`; probe throws a
 * non-infrastructure error → `CLOSED` (existing "logically reachable" rule,
 * unchanged from before this fix). A corollary, stated as its own checkable
 * property because it is what the issue calls out explicitly and what the
 * pre-fix code violated: if any evaluated schedule ever produces *two* real
 * downstream calls for the same episode (an implementation regression of
 * INV1), the failure outcome must still win, i.e. the episode must never
 * end up `CLOSED` if any of the racing probes reported an infrastructure
 * failure. The fixed implementation satisfies this vacuously (INV1 makes the
 * race impossible); the fuzzer checks it directly, and the reintroduced-bug
 * baseline is used to show the check is not vacuous in general (it fires
 * against code where the race is possible).
 *
 * ### INV3 — Linearizability: some sequential ordering explains any outcome
 *
 * For any set of N concurrent `getScore` calls against one instance, there
 * exists a sequential ordering of "logical operations" — one per real
 * downstream call (CLOSED-state calls and the single HALF_OPEN probe per
 * episode), *not* one per caller — replaying which against this state
 * machine deterministically reproduces the actual final `state` / `failures`
 * / `nextAttempt`. This follows from the ground rule (each logical
 * operation's state transition is atomic and therefore has a well-defined
 * position in real time relative to the others) plus INV1 (coalesced callers
 * contribute no additional logical operation — they only observe — so they
 * cannot introduce an ordering ambiguity beyond the one already implied by
 * the real operations' settlement order).
 *
 * ### Design choice this fix makes (documented per the issue's requirement)
 *
 * Concurrent callers admitted during an active HALF_OPEN probe **coalesce**
 * onto that probe's outcome rather than failing fast. This was chosen over
 * fail-fast because it gives callers a real answer (the same one the probe
 * gets) instead of an arbitrary "try again" error, mirrors the coalescing
 * behavior `CoalescingOracle` already provides one layer up (so the two
 * decorators agree on this policy when stacked), and is what makes INV2's
 * "no race to arbitrate" property hold by construction instead of by adding
 * a second arbitration mechanism.
 */
export class CircuitBreakerOracle implements RiskOracle {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures: number = 0;
  private nextAttempt: number = 0;
  private readonly isInfraError: (error: unknown) => boolean;

  /**
   * Non-null exactly while a HALF_OPEN probe is outstanding (i.e. exactly
   * when `state === HALF_OPEN`, see INV1). Concurrent callers admitted while
   * this is set coalesce onto it instead of invoking `oracle.getScore` again.
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

      // Cooldown elapsed: admit exactly one probe for this episode (INV1).
      // Everything from reading `state`/`nextAttempt` above to setting
      // `halfOpenProbe` below is one synchronous stretch with no `await`,
      // so no other concurrent call can observe a half-finished transition.
      if (this.halfOpenProbe === null) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.halfOpenProbe = this.runProbe(destination);
      }
      return this.halfOpenProbe;
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // A probe admitted by a previous call is still outstanding; coalesce
      // onto it (INV1) instead of issuing a second downstream call.
      if (this.halfOpenProbe === null) {
        // Unreachable if INV1 holds: `state` only ever becomes HALF_OPEN in
        // the same synchronous block that sets `halfOpenProbe` (above), and
        // both are only cleared together, in `runProbe`'s `finally`. Fail
        // loudly rather than silently double-probing if this ever regresses.
        throw new Error(
          'CircuitBreakerOracle invariant violated: HALF_OPEN with no active probe (INV1)',
        );
      }
      return this.halfOpenProbe;
    }

    // CLOSED: each call is independent; no probe admission/coalescing applies.
    try {
      return await this.oracle.getScore(destination);
    } catch (error) {
      if (this.isInfraError(error)) {
        this.recordFailure();
        return this.handleFallback(destination, error);
      }
      throw error;
    }
  }

  /**
   * The single HALF_OPEN probe for one OPEN episode (INV1). Every caller
   * coalesced onto this promise receives exactly this settlement, which is
   * what makes INV2/INV3 hold for the episode.
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

      // Non-infrastructure errors indicate the system is logically reachable.
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
