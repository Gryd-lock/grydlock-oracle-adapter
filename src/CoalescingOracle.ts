import { RiskOracle } from './RiskOracle';
import { Logger, noopLogger } from './Logger';

/**
 * Decorator that de-duplicates concurrent `getScore(destination)` calls.
 *
 * While a request for a given destination is in-flight, subsequent callers
 * return the same promise instead of issuing a new underlying request.
 *
 * ## Concurrency invariant (written correctness argument)
 *
 * INV — No unhandled rejection: `getScore` never leaves a rejected promise
 * with zero attached rejection handlers on the microtask queue, for any
 * success/failure pattern of `inner.getScore`, for any number of concurrent
 * or sequential callers.
 *
 * `p = this.inner.getScore(destination)` is the only promise this method
 * creates from a fresh inner call, and it is the exact value returned to the
 * caller. Two more reactions are attached to `p` for internal bookkeeping:
 * `p.finally(cleanup).catch(noop)` and `p.catch(logOnly)`. Node/browsers only
 * report a rejection as unhandled if, by the end of the microtask checkpoint
 * following its rejection, the promise has no rejection handler attached
 * anywhere. `p` itself has two (`.finally`'s implicit pass-through counts as
 * deriving from `p`, and the direct `.catch(logOnly)`), and both of *those*
 * derived promises are themselves terminated with a handler that does not
 * rethrow (`.catch(() => {})` and the non-rethrowing body of `logOnly`), so
 * no promise anywhere in this chain — including `p` itself — can reach "settled
 * rejected, unobserved" at any point after `getScore` returns. This holds
 * independent of the caller: whether or not the caller of `getScore` ever
 * awaits or attaches a handler to the promise it received, none of the
 * *internal* chains this method creates can leak.
 *
 * The fuzzer in `tests/concurrency` installs a real `process.on(
 * 'unhandledRejection', ...)` listener and exercises many randomized
 * success/failure/settlement-order schedules to check this invariant holds
 * under concurrency, not just in the single-call case.
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
