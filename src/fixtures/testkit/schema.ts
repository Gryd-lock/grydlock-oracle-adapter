/**
 * Runtime shape validation for the vendored grydlock-testkit fixtures.
 *
 * The fixtures under src/fixtures/testkit/ are manually copied from the
 * grydlock-testkit repo (see README) rather than pulled in as a dependency,
 * so a bad copy — truncated file, wrong schema version, non-numeric score —
 * would otherwise pass TypeScript's structural typing silently and only
 * surface as a confusing runtime failure (or not fail at all).
 */

export class FixtureValidationError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid vendored fixture "${file}": ${detail}`);
    this.name = 'FixtureValidationError';
  }
}

export type ScoresFixture = Readonly<Record<string, number>>;

/**
 * Validates the shape of scores.json: a JSON object mapping every
 * destination id to a finite score in the inclusive 0-100 range.
 */
export function validateScoresFixture(file: string, data: unknown): ScoresFixture {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new FixtureValidationError(
      file,
      `expected a JSON object mapping destination -> score, got ${describe(data)}`,
    );
  }

  for (const [destination, score] of Object.entries(data as Record<string, unknown>)) {
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new FixtureValidationError(
        file,
        `score for "${destination}" must be a finite number, got ${describe(score)}`,
      );
    }
    if (score < 0 || score > 100) {
      throw new FixtureValidationError(
        file,
        `score for "${destination}" must be within 0-100, got ${score}`,
      );
    }
  }

  return data as ScoresFixture;
}

export interface DestinationFixture {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly notes: string;
}

export interface DestinationsFixture {
  readonly destinations: readonly DestinationFixture[];
}

/**
 * Validates the shape of destinations.json: an object with a
 * `destinations` array, where every entry has non-empty string
 * `id`, `type`, `label`, and `notes` fields.
 */
export function validateDestinationsFixture(file: string, data: unknown): DestinationsFixture {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new FixtureValidationError(file, `expected a JSON object, got ${describe(data)}`);
  }

  const destinations = (data as Record<string, unknown>).destinations;
  if (!Array.isArray(destinations)) {
    throw new FixtureValidationError(
      file,
      `expected field "destinations" to be an array, got ${describe(destinations)}`,
    );
  }

  destinations.forEach((entry, index) => {
    for (const field of ['id', 'type', 'label', 'notes'] as const) {
      const value = (entry as Record<string, unknown> | null)?.[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new FixtureValidationError(
          file,
          `destinations[${index}].${field} must be a non-empty string, got ${describe(value)}`,
        );
      }
    }
  });

  return data as DestinationsFixture;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `${typeof value} (${JSON.stringify(value)})`;
}
