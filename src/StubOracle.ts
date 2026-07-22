import { validateDestination } from './DestinationValidator';
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
import { Logger, NoopLogger } from './Logger';

export class StubOracle implements RiskOracle {
  /**
   * Looks the destination up in the vendored `grydlock-testkit` fixture scores.
   *
   * @param destination A Stellar address or asset identifier, validated by
   * {@link validateDestination} before the lookup. Muxed (`M...`) destinations
   * are looked up under their base `G` account.
   * @returns The fixture score for `destination`, or a default low-risk score
   * of `0` when the destination is not present in the fixtures (so the
   * extension always has a number to render).
   * @throws {InvalidDestinationError} If `destination` is malformed.
   */
  async getScore(destination: string): Promise<number> {
    const { canonical } = validateDestination(destination);

    return scores[canonical] ?? DEFAULT_SCORE;
  }
}

