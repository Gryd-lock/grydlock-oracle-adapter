import { RiskOracle } from './RiskOracle';
import { Logger, noopLogger } from './Logger';

/**
 * Decorator that de-duplicates concurrent `getScore(destination)` calls.
 *
 * While a request for a given destination is in-flight, subsequent callers
 * return the same promise instead of issuing a new underlying request.
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

    // Ensure the entry is removed after success or failure so a later call
    // can retry. Cleanup is a single `.then(onSuccess, onFailure)` reaction
    // directly on `p` — not `.finally()` chained into a separate `.catch()`.
    // `.finally()` plus a trailing `.catch()` takes two microtask hops after
    // `p` settles; a caller that awaits the rejection and immediately
    // retries can resolve in fewer hops than that (vitest's own
    // `rejects.toBe` matcher does), observing the stale map entry before
    // this chain got to it. A single `.then()` here — registered before `p`
    // settles, so it is queued ahead of anything a caller registers
    // afterwards — clears the entry in one hop, and never rethrows, so it
    // can't become an unhandled rejection either. The original `p` returned
    // below is untouched, so callers still see the real result/rejection.
    p.then(
      () => this.clearInFlight(destination, p),
      (err: unknown) => {
        this.clearInFlight(destination, p);
        this.logger.warn('CoalescingOracle.innerFailed', { destination, err });
      },
    );

    return p;
  }

  private clearInFlight(destination: string, p: Promise<number>): void {
    // Only delete if it's still the same promise instance.
    if (this.inFlightByDestination.get(destination) === p) {
      this.inFlightByDestination.delete(destination);
      this.logger.debug('CoalescingOracle.inFlightEnd', { destination });
    }
  }
}
