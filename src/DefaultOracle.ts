import { RiskOracle } from './RiskOracle';

/**
 * Oracle that always returns the configured default score.
 */
export class DefaultOracle implements RiskOracle {
  constructor(private readonly score = 0) {}

  async getScore(): Promise<number> {
    return this.score;
  }
}
