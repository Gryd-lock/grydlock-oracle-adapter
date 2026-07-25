import destinationsText from './destinations.text';
import { parseDestinationsFixtureIncremental } from './schema';

// See scores.ts for why this lives in its own module rather than
// alongside `scores`, and for why this parses raw text incrementally
// instead of importing destinations.json (which a bundler would parse into
// a full object graph before we ever got a chance to validate it).
export const destinations = parseDestinationsFixtureIncremental('destinations.json', destinationsText);
