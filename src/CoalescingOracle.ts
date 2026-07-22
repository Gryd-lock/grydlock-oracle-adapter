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
    });

    p.catch((err) => {
      // Attach a logger side-effect without changing the thrown error.
      this.logger.warn('CoalescingOracle.innerFailed', { destination, err });
      throw err;
    });

    return p;
  }
}
