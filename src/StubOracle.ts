import { StrKey } from '@stellar/stellar-sdk';
import { InvalidDestinationError } from './OracleError';
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
export class StubOracle implements RiskOracle {
  async getScore(destination: string): Promise<number> {
    const isAccount = StrKey.isValidEd25519PublicKey(destination);
    const isContract = StrKey.isValidContract(destination);

    let isAsset = false;

    const parts = destination.split(':');

    if (parts.length === 2) {
      const [, issuer] = parts;

      isAsset = StrKey.isValidEd25519PublicKey(issuer);
    }

    if (!isAccount && !isContract && !isAsset) {
      throw new InvalidDestinationError(destination);
    }

    return SCORES[destination] ?? DEFAULT_SCORE;
  }
}
