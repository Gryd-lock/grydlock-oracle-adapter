// `scores` and `destinations` are re-exported from separate modules (rather
// than validated inline here) so that importing one doesn't force the
// other's JSON + validation into the bundle — see scores.ts/destinations.ts.
export { scores } from './scores';
export { destinations } from './destinations';

export { FixtureValidationError } from './schema';
export type { ScoresFixture, DestinationFixture, DestinationsFixture } from './schema';
