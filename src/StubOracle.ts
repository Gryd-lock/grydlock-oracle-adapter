import { RiskOracle } from './RiskOracle';

const SCORES: Readonly<Record<string, number>> = {
  'GAKNOWNWASHTRADERWALLETEXAMPLE': 95,
  'GAKNOWNCLEANWALLETEXAMPLE': 5,
  'XLM/USDC:GASUSPICIOUSASSETISSUEREXAMPLE': 60,
};

// Unrecognized destinations are treated as low-risk rather than unscored,
// so the extension always has a number to render.
const DEFAULT_SCORE = 0;

/**
 * In-memory RiskOracle backed by a small hardcoded lookup table.
 *
 * Used for local development and the grydlock-testkit evaluation so the
 * extension's signing flow can be built and tested with no live oracle
 * and no network access.
 */
export class StubOracle implements RiskOracle {
  async getScore(destination: string): Promise<number> {
    return SCORES[destination] ?? DEFAULT_SCORE;
  }
}
