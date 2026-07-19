import { RiskOracle } from './RiskOracle';
import testkitScores from './fixtures/testkit/scores.json';

const SCORES: Readonly<Record<string, number>> = testkitScores;

// Unrecognized destinations are treated as low-risk rather than unscored,
// so the extension always has a number to render.
const DEFAULT_SCORE = 0;

/**
 * In-memory RiskOracle backed by the grydlock-testkit fixture scores
 * (vendored at src/fixtures/testkit/scores.json). Used for local
 * development and the grydlock-testkit evaluation so the extension's
 * signing flow can be built and tested with no live oracle and no
 * network access.
 */
import { Logger, NoopLogger } from './Logger';

export class StubOracle implements RiskOracle {
  constructor(private readonly logger: Logger = NoopLogger) {}

  async getScore(destination: string): Promise<number> {
    const score = SCORES[destination] ?? DEFAULT_SCORE;

    // Keep this behind debug; production consumers can wire a real logger.
    this.logger.debug('StubOracle.getScore', {
      destination,
      score,
      hit: SCORES[destination] !== undefined,
    });

    return score;
  }
}

