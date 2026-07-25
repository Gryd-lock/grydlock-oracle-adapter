/**
 * Runtime shape validation for the vendored grydlock-testkit fixtures.
 *
 * The fixtures under src/fixtures/testkit/ are manually copied from the
 * grydlock-testkit repo (see README) rather than pulled in as a dependency,
 * so a bad copy — truncated file, wrong schema version, non-numeric score —
 * would otherwise pass TypeScript's structural typing silently and only
 * surface as a confusing runtime failure (or not fail at all).
 *
 * Two entry points are exported for each fixture:
 *
 *  - `validateScoresFixture`/`validateDestinationsFixture` validate an
 *    already-parsed JS value (useful when you already have one, e.g. in a
 *    test). These require the full object graph to already exist.
 *  - `parseScoresFixtureIncremental`/`parseDestinationsFixtureIncremental`
 *    validate raw JSON *text* one token/entry at a time (see jsonScanner.ts),
 *    so a malformed entry is caught — with an accurate source position —
 *    without ever materializing a parsed representation of the rest of the
 *    file. This is what the real vendored fixtures are loaded through (see
 *    scores.ts/destinations.ts); the object-based validators above remain
 *    for callers that already have a parsed value on hand.
 */

import { JsonScanner, JsonSyntaxError, describeToken, type SourcePosition } from './jsonScanner';

export type { SourcePosition };

export class FixtureValidationError extends Error {
  /** Source position of the offending entry, when known (see jsonScanner.ts). */
  readonly position?: SourcePosition;

  constructor(file: string, detail: string, position?: SourcePosition) {
    const where = position
      ? ` (at line ${position.line}, column ${position.column}, offset ${position.offset})`
      : '';
    super(`Invalid vendored fixture "${file}": ${detail}${where}`);
    this.name = 'FixtureValidationError';
    this.position = position;
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

/** Re-throws a low-level JSON syntax error as the same FixtureValidationError shape. */
function asFixtureError(file: string, error: unknown): FixtureValidationError {
  if (error instanceof JsonSyntaxError) {
    return new FixtureValidationError(file, error.message.replace(/^Malformed JSON in "[^"]*" at [^:]*: /, 'malformed JSON: '), error.position);
  }
  throw error;
}

/**
 * Incrementally parses + validates scores.json's raw text: a JSON object
 * mapping every destination id to a finite score in the inclusive 0-100
 * range. Each key/value pair is validated as soon as it is tokenized —
 * a malformed entry throws before any later entry is even scanned.
 */
export function parseScoresFixtureIncremental(file: string, text: string): ScoresFixture {
  const s = new JsonScanner(text, file);
  try {
    s.skipWhitespace();
    if (s.peekChar() !== '{') {
      const rootPos = s.position;
      const token = s.readValueForDescription();
      throw new FixtureValidationError(
        file,
        `expected a JSON object mapping destination -> score, got ${describeToken(token)}`,
        rootPos,
      );
    }
    s.consumeChar('{');
    const result: Record<string, number> = Object.create(null);

    s.skipWhitespace();
    if (s.peekChar() === '}') {
      s.consumeChar('}');
    } else {
      for (;;) {
        s.skipWhitespace();
        const destination = s.readString();
        s.skipWhitespace();
        s.consumeChar(':');
        s.skipWhitespace();
        const valuePos = s.position;

        const score = s.tryReadNumber();
        if (score === undefined) {
          const token = s.readValueForDescription();
          throw new FixtureValidationError(
            file,
            `score for "${destination}" must be a finite number, got ${describeToken(token)}`,
            valuePos,
          );
        }
        if (!Number.isFinite(score)) {
          throw new FixtureValidationError(
            file,
            `score for "${destination}" must be a finite number, got ${score}`,
            valuePos,
          );
        }
        if (score < 0 || score > 100) {
          throw new FixtureValidationError(
            file,
            `score for "${destination}" must be within 0-100, got ${score}`,
            valuePos,
          );
        }
        result[destination] = score;

        s.skipWhitespace();
        const c = s.peekChar();
        if (c === ',') {
          s.consumeChar(',');
          continue;
        }
        if (c === '}') {
          s.consumeChar('}');
          break;
        }
        throw s.error(`expected "," or "}"`);
      }
    }

    s.skipWhitespace();
    if (!s.atEnd()) {
      throw s.error('unexpected trailing content after top-level value');
    }

    return result as ScoresFixture;
  } catch (error) {
    if (error instanceof FixtureValidationError) throw error;
    throw asFixtureError(file, error);
  }
}

const REQUIRED_DESTINATION_FIELDS = ['id', 'type', 'label', 'notes'] as const;

function parseDestinationEntry(
  s: JsonScanner,
  file: string,
  index: number,
): DestinationFixture {
  const entryPos = s.position;
  if (s.peekChar() !== '{') {
    // Matches the object-based validator's behavior: indexing a missing or
    // non-object entry for any field yields `undefined`, regardless of what
    // the entry actually is.
    throw new FixtureValidationError(
      file,
      `destinations[${index}].${REQUIRED_DESTINATION_FIELDS[0]} must be a non-empty string, got undefined`,
      entryPos,
    );
  }
  s.consumeChar('{');

  const fields: Partial<Record<(typeof REQUIRED_DESTINATION_FIELDS)[number], string>> = {};

  s.skipWhitespace();
  if (s.peekChar() !== '}') {
    for (;;) {
      s.skipWhitespace();
      const key = s.readString();
      s.skipWhitespace();
      s.consumeChar(':');
      s.skipWhitespace();
      const valuePos = s.position;

      if ((REQUIRED_DESTINATION_FIELDS as readonly string[]).includes(key)) {
        const value = s.tryReadString();
        if (value === undefined) {
          const token = s.readValueForDescription();
          throw new FixtureValidationError(
            file,
            `destinations[${index}].${key} must be a non-empty string, got ${describeToken(token)}`,
            valuePos,
          );
        }
        if (value.length === 0) {
          throw new FixtureValidationError(
            file,
            `destinations[${index}].${key} must be a non-empty string, got ${describeToken({ kind: 'string', value })}`,
            valuePos,
          );
        }
        (fields as Record<string, string>)[key] = value;
      } else {
        s.skipValue();
      }

      s.skipWhitespace();
      const c = s.peekChar();
      if (c === ',') {
        s.consumeChar(',');
        continue;
      }
      if (c === '}') {
        s.consumeChar('}');
        break;
      }
      throw s.error(`expected "," or "}"`);
    }
  } else {
    s.consumeChar('}');
  }

  for (const field of REQUIRED_DESTINATION_FIELDS) {
    if (fields[field] === undefined) {
      throw new FixtureValidationError(
        file,
        `destinations[${index}].${field} must be a non-empty string, got undefined`,
        entryPos,
      );
    }
  }

  return fields as DestinationFixture;
}

/**
 * Incrementally parses + validates destinations.json's raw text: an object
 * with a `destinations` array, where every entry has non-empty string
 * `id`, `type`, `label`, and `notes` fields. Each entry is validated as
 * soon as its closing `}` is tokenized — a malformed entry throws before
 * any later entry in the array is even scanned.
 */
export function parseDestinationsFixtureIncremental(file: string, text: string): DestinationsFixture {
  const s = new JsonScanner(text, file);
  try {
    s.skipWhitespace();
    if (s.peekChar() !== '{') {
      const rootPos = s.position;
      const token = s.readValueForDescription();
      throw new FixtureValidationError(file, `expected a JSON object, got ${describeToken(token)}`, rootPos);
    }
    s.consumeChar('{');

    const destinations: DestinationFixture[] = [];
    let sawDestinationsField = false;

    s.skipWhitespace();
    if (s.peekChar() === '}') {
      s.consumeChar('}');
    } else {
      for (;;) {
        s.skipWhitespace();
        const key = s.readString();
        s.skipWhitespace();
        s.consumeChar(':');
        s.skipWhitespace();

        if (key === 'destinations') {
          sawDestinationsField = true;
          if (s.peekChar() !== '[') {
            const fieldPos = s.position;
            const token = s.readValueForDescription();
            throw new FixtureValidationError(
              file,
              `expected field "destinations" to be an array, got ${describeToken(token)}`,
              fieldPos,
            );
          }
          s.consumeChar('[');
          s.skipWhitespace();
          if (s.peekChar() === ']') {
            s.consumeChar(']');
          } else {
            let index = 0;
            for (;;) {
              s.skipWhitespace();
              destinations.push(parseDestinationEntry(s, file, index));
              index++;
              s.skipWhitespace();
              const c = s.peekChar();
              if (c === ',') {
                s.consumeChar(',');
                continue;
              }
              if (c === ']') {
                s.consumeChar(']');
                break;
              }
              throw s.error(`expected "," or "]"`);
            }
          }
        } else {
          s.skipValue();
        }

        s.skipWhitespace();
        const c = s.peekChar();
        if (c === ',') {
          s.consumeChar(',');
          continue;
        }
        if (c === '}') {
          s.consumeChar('}');
          break;
        }
        throw s.error(`expected "," or "}"`);
      }
    }

    if (!sawDestinationsField) {
      throw new FixtureValidationError(file, `expected field "destinations" to be an array, got undefined`);
    }

    s.skipWhitespace();
    if (!s.atEnd()) {
      throw s.error('unexpected trailing content after top-level value');
    }

    return { destinations } as DestinationsFixture;
  } catch (error) {
    if (error instanceof FixtureValidationError) throw error;
    throw asFixtureError(file, error);
  }
}
