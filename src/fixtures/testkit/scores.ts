import rawScores from './scores.json';
import { validateScoresFixture } from './schema';

// Validated once, at module load, when this file is first imported — not
// on every StubOracle.getScore() call. Kept in its own module (rather than
// alongside destinations.ts) so that importing just `scores` — StubOracle's
// only need — doesn't force destinations.json into the bundle too; see
// index.ts.
export const scores = validateScoresFixture('scores.json', rawScores);
