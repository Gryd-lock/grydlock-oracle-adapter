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
    // can retry.
    p.finally(() => {
      // Only delete if it's still the same promise instance.
      if (this.inFlightByDestination.get(destination) === p) {
        this.inFlightByDestination.delete(destination);
        this.logger.debug('CoalescingOracle.inFlightEnd', { destination });
      }
    }).catch(() => {
      // `finally` passes a rejection straight through, so this bookkeeping
      // chain mirrors p's rejection. Callers receive `p` itself and own its
      // rejection; swallow it here so it is not reported as an unhandled one.
    });

    p.catch((err) => {
      // Log the failure without rethrowing: the derived promise is discarded,
      // so rethrowing here would surface as an unhandled rejection while
      // changing nothing for the caller awaiting `p`.
      this.logger.warn('CoalescingOracle.innerFailed', { destination, err });
    });

    return p;
  }
}



