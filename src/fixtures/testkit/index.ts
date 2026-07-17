import rawScores from './scores.json';
import rawDestinations from './destinations.json';
import { validateScoresFixture, validateDestinationsFixture } from './schema';

// Validated once, at module load, when this file is first imported —
// not on every StubOracle.getScore() call.
export const scores = validateScoresFixture('scores.json', rawScores);
export const destinations = validateDestinationsFixture('destinations.json', rawDestinations);

export { FixtureValidationError } from './schema';
export type { ScoresFixture, DestinationFixture, DestinationsFixture } from './schema';
