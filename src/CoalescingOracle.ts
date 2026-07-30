import { RiskOracle } from './RiskOracle';
import { Logger, noopLogger } from './Logger';

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
 */
export class CoalescingOracle implements RiskOracle {
  private readonly inFlightByDestination = new Map<string, Promise<number>>();

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

  private clearInFlight(destination: string, p: Promise<number>): void {
    // Only delete if it's still the same promise instance: a later call for
    // the same destination may already have installed a fresh in-flight
    // promise by the time this settlement handler runs.
    if (this.inFlightByDestination.get(destination) === p) {
      this.inFlightByDestination.delete(destination);
      this.logger.debug('CoalescingOracle.inFlightEnd', { destination });
    }
  }
}
