import rawDestinations from './destinations.json';
import { validateDestinationsFixture } from './schema';

// See scores.ts for why this lives in its own module rather than
// alongside `scores`.
export const destinations = validateDestinationsFixture('destinations.json', rawDestinations);
