import { RiskOracle } from './RiskOracle';
import { scores } from './fixtures/testkit';

// Unrecognized destinations are treated as low-risk rather than unscored,
// so the extension always has a number to render.
const DEFAULT_SCORE = 0;

/**
 * In-memory RiskOracle backed by the grydlock-testkit fixture scores
 * (vendored at src/fixtures/testkit/scores.json, shape-checked once at
 * module load by src/fixtures/testkit/index.ts). Used for local
 * development and the grydlock-testkit evaluation so the extension's
 * signing flow can be built and tested with no live oracle and no
 * network access.
 */
export class StubOracle implements RiskOracle {
  async getScore(destination: string): Promise<number> {
    return scores[destination] ?? DEFAULT_SCORE;
  }
}
