import { RiskOracle } from './RiskOracle';
import { FallbackObserver } from './FallbackObserver';

/**
 * Tries multiple oracles in priority order until one succeeds.
 */
export class FallbackOracle implements RiskOracle {
  constructor(
    private readonly chain: readonly RiskOracle[],
    private readonly observer?: FallbackObserver,
  ) {}

  async getScore(destination: string): Promise<number> {
    let lastError: unknown;

    for (const oracle of this.chain) {
      try {
        return await oracle.getScore(destination);
      } catch (error) {
        lastError = error;
        this.observer?.onFallback(error, oracle);
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('FallbackOracle has no configured oracles.');
  }
}