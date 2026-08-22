import { RiskOracle } from './RiskOracle';
import { Logger, noopLogger } from './Logger';
import { CancellableRiskOracle, isCancellable } from './CancellableRiskOracle';
import { OracleCancelledError } from './OracleError';

/** Bookkeeping for one in-flight cancellable request, shared by every caller coalesced onto it. */
interface CancellableInFlightEntry {
  promise: Promise<number>;
  /** Controls the *shared* underlying call — aborted only once every attached caller has cancelled. */
  controller: AbortController;
  /** Count of callers currently coalesced on `promise` that have not yet cancelled. */
  attachedCount: number;
  /**
   * Whether `this.inner` actually implements `CancellableRiskOracle`, i.e.
   * whether `controller.abort()` genuinely stops the underlying request
   * rather than being a no-op. Determines whether it's safe to eagerly
   * remove this entry once every caller has cancelled — see the doc at that
   * call site below.
   */
  innerIsCancellable: boolean;
}

/**
 * Decorator that de-duplicates concurrent `getScore(destination)` calls.
 *
 * While a request for a given destination is in-flight, subsequent callers
 * return the same promise instead of issuing a new underlying request.
 *
 * # Concurrency invariants
 *
 * The full correctness argument lives in `CONCURRENCY_INVARIANTS.md`.
 * In short:
 *
 * - **INV-CO-1 (no floating rejection)**: every promise this class derives
 *   from the inner call (`p`) has a rejection handler attached to it
 *   *synchronously*, in the same turn it is created, before control returns
 *   to the event loop. `getScore` never does `p.catch(err => { ...; throw
 *   err; })` and discards the result — that pattern creates a *new* promise
 *   (the `.catch()` call's return value) that itself rejects and is never
 *   observed, which is exactly what trips Node's `unhandledRejection`.
 * - **INV-CO-2 (single underlying call)**: for a given destination, at most
 *   one call to `this.inner.getScore` is in flight at a time; all coalesced
 *   callers observe the same settlement (same value on success, same error
 *   object on failure, via reference equality) as that one call.
 *
 * ## Cancellation (issue #98)
 *
 * `getScoreCancellable` maintains its own, entirely separate coalescing pool
 * from `getScore` — a cancellable and a non-cancellable call for the same
 * destination do not coalesce onto each other. A plain `getScore` caller has
 * no signal and so could never contribute to "every attached caller has
 * cancelled"; sharing the pools would mean a single non-cancellable caller
 * permanently prevents the shared request from ever being real-aborted,
 * which defeats the point. Keeping them separate also means `getScore` and
 * its documented invariants above are completely unchanged by this feature.
 *
 * Multiple callers can coalesce onto one shared underlying cancellable call.
 * One caller cancelling must not affect callers still waiting — only once
 * *every* currently-attached caller has cancelled is the shared call's own
 * `AbortController` actually aborted, so the resource is freed but a lone
 * still-interested caller is never starved by someone else's cancellation.
 */
export class CoalescingOracle implements RiskOracle, CancellableRiskOracle {
  private readonly inFlightByDestination = new Map<string, Promise<number>>();
  private readonly cancellableInFlightByDestination = new Map<string, CancellableInFlightEntry>();

  constructor(
    private readonly inner: RiskOracle,
    private readonly logger: Logger = noopLogger,
  ) {}

  async getScore(destination: string): Promise<number> {
    const existing = this.inFlightByDestination.get(destination);
    if (existing) {
      this.logger.debug('CoalescingOracle.coalesced', { destination });
      return existing;
    }

    this.logger.debug('CoalescingOracle.inFlightStart', { destination });

    const p = this.inner.getScore(destination);
    this.inFlightByDestination.set(destination, p);

    // Single derived chain, attached synchronously (INV-CO-1): clears the
    // bookkeeping entry on settlement and, on failure, logs it. Both
    // reactions are registered on `p` in this same synchronous turn, and the
    // handler never rethrows, so this chain's own promise always resolves —
    // there is nothing left over for `unhandledRejection` to catch.
    p.then(
      () => this.clearInFlight(destination, p),
      (err) => {
        this.clearInFlight(destination, p);
        this.logger.warn('CoalescingOracle.innerFailed', { destination, err });
      },
    );

    return p;
  }

  /**
   * Cancellable counterpart to {@link getScore} — see the class doc's
   * "Cancellation" section for the coalescing/abort semantics.
   */
  getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
    if (signal.aborted) {
      return Promise.reject(new OracleCancelledError('The oracle request was cancelled.', { destination }));
    }

    let entry = this.cancellableInFlightByDestination.get(destination);
    if (!entry) {
      this.logger.debug('CoalescingOracle.cancellableInFlightStart', { destination });
      const controller = new AbortController();
      const innerIsCancellable = isCancellable(this.inner);
      const promise = innerIsCancellable
        ? this.inner.getScoreCancellable(destination, controller.signal)
        : this.inner.getScore(destination);
      const newEntry: CancellableInFlightEntry = {
        promise,
        controller,
        attachedCount: 0,
        innerIsCancellable,
      };
      entry = newEntry;
      this.cancellableInFlightByDestination.set(destination, newEntry);

      // Top-level bookkeeping chain, attached synchronously (INV-CO-1),
      // independent of any individual caller's own race below — mirrors
      // getScore's p.then(...) above.
      promise.then(
        () => this.clearCancellableInFlight(destination, newEntry),
        (err) => {
          this.clearCancellableInFlight(destination, newEntry);
          this.logger.warn('CoalescingOracle.cancellableInnerFailed', { destination, err });
        },
      );
    } else {
      this.logger.debug('CoalescingOracle.cancellableCoalesced', { destination });
    }

    const attachedEntry = entry;
    attachedEntry.attachedCount++;

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        attachedEntry.attachedCount--;
        if (attachedEntry.attachedCount === 0) {
          attachedEntry.controller.abort();
          if (attachedEntry.innerIsCancellable) {
            // Every caller has cancelled and the abort() above genuinely
            // stops the resource: safe to remove the entry immediately
            // rather than waiting for `promise` to settle from the abort —
            // otherwise a new caller arriving in that window would coalesce
            // onto an already-doomed request. If the inner oracle is *not*
            // cancellable, `abort()` did nothing — the real request is
            // still running — so the entry is deliberately left in place: a
            // new caller should coalesce onto that still-live request
            // instead of starting a wasteful duplicate one, and the
            // top-level `promise.then(...)` cleanup above removes the entry
            // once it genuinely settles.
            this.clearCancellableInFlight(destination, attachedEntry);
          }
        }
        signal.removeEventListener('abort', onAbort);
        reject(new OracleCancelledError('The oracle request was cancelled.', { destination }));
      };
      signal.addEventListener('abort', onAbort);

      attachedEntry.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private clearInFlight(destination: string, p: Promise<number>): void {
    // Only delete if it's still the same promise instance: a later call for
    // the same destination may already have installed a fresh in-flight
    // promise by the time this settlement handler runs.
    if (this.inFlightByDestination.get(destination) === p) {
      this.inFlightByDestination.delete(destination);
      this.logger.debug('CoalescingOracle.inFlightEnd', { destination });
    }
  }

  private clearCancellableInFlight(destination: string, entry: CancellableInFlightEntry): void {
    if (this.cancellableInFlightByDestination.get(destination) === entry) {
      this.cancellableInFlightByDestination.delete(destination);
      this.logger.debug('CoalescingOracle.cancellableInFlightEnd', { destination });
    }
  }
}
