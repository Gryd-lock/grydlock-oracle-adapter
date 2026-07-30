import scoresText from './scores.text';
import { parseScoresFixtureIncremental } from './schema';

// Parsed + validated incrementally, token-at-a-time, once at module load —
// not on every StubOracle.getScore() call, and without ever materializing a
// full JSON.parse object graph of scores.json first (see schema.ts). Kept
// in its own module (rather than alongside destinations.ts) so that
// importing just `scores` — StubOracle's only need — doesn't force
// destinations.json into the bundle too; see index.ts.
export const scores = parseScoresFixtureIncremental('scores.json', scoresText);
