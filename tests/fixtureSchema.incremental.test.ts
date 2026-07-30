import { describe, expect, it } from 'vitest';
import {
  FixtureValidationError,
  parseDestinationsFixtureIncremental,
  parseScoresFixtureIncremental,
} from '../src/fixtures/testkit/schema';

describe('parseScoresFixtureIncremental', () => {
  it('accepts a well-formed scores fixture', () => {
    const result = parseScoresFixtureIncremental('scores.json', '{"GABC": 10, "GDEF": 90}');
    expect(result).toEqual({ GABC: 10, GDEF: 90 });
  });

  it('accepts an empty scores fixture', () => {
    expect(parseScoresFixtureIncremental('scores.json', '{}')).toEqual({});
  });

  it('rejects a truncated fixture (not an object)', () => {
    expect(() => parseScoresFixtureIncremental('scores.json', 'null')).toThrow(FixtureValidationError);
    expect(() => parseScoresFixtureIncremental('scores.json', '[]')).toThrow(FixtureValidationError);
  });

  it('rejects a non-numeric score with a message naming the file, destination, value, and position', () => {
    const text = '{"GABC": "10"}';

    try {
      parseScoresFixtureIncremental('scores.json', text);
      expect.unreachable('parseScoresFixtureIncremental should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      const fixtureError = error as FixtureValidationError;
      expect(fixtureError.message).toContain('scores.json');
      expect(fixtureError.message).toContain('GABC');
      expect(fixtureError.message).toContain('"10"');
      expect(fixtureError.position).toBeDefined();
      // The value "10" starts right after `{"GABC": `.
      expect(fixtureError.position?.offset).toBe(text.indexOf('"10"'));
      expect(fixtureError.position?.line).toBe(1);
    }
  });

  it('rejects a score outside the 0-100 range', () => {
    expect(() => parseScoresFixtureIncremental('scores.json', '{"GABC": 101}')).toThrow(
      FixtureValidationError,
    );
    expect(() => parseScoresFixtureIncremental('scores.json', '{"GABC": -1}')).toThrow(
      FixtureValidationError,
    );
  });

  it('reports an accurate line/column for an entry after a multi-line prefix', () => {
    const text = '{\n  "GABC": 10,\n  "GDEF": 200\n}';

    try {
      parseScoresFixtureIncremental('scores.json', text);
      expect.unreachable('parseScoresFixtureIncremental should have thrown');
    } catch (error) {
      const fixtureError = error as FixtureValidationError;
      expect(fixtureError.position?.line).toBe(3);
      expect(fixtureError.position?.column).toBe(11);
    }
  });

  it('stops at the first malformed entry without scanning entries after it', () => {
    const text = '{"GABC": "not-a-number", "GDEF": "also-not-a-number"}';

    try {
      parseScoresFixtureIncremental('scores.json', text);
      expect.unreachable('parseScoresFixtureIncremental should have thrown');
    } catch (error) {
      expect((error as FixtureValidationError).message).toContain('GABC');
      expect((error as FixtureValidationError).message).not.toContain('GDEF');
    }
  });
});

describe('parseDestinationsFixtureIncremental', () => {
  it('accepts a well-formed destinations fixture', () => {
    const text = JSON.stringify({
      destinations: [{ id: 'GABC', type: 'account', label: 'clean', notes: 'ok' }],
    });

    expect(parseDestinationsFixtureIncremental('destinations.json', text)).toEqual({
      destinations: [{ id: 'GABC', type: 'account', label: 'clean', notes: 'ok' }],
    });
  });

  it('accepts an empty destinations array', () => {
    expect(parseDestinationsFixtureIncremental('destinations.json', '{"destinations": []}')).toEqual({
      destinations: [],
    });
  });

  it('rejects a fixture missing the destinations array (wrong schema version)', () => {
    try {
      parseDestinationsFixtureIncremental('destinations.json', '{"entries": []}');
      expect.unreachable('parseDestinationsFixtureIncremental should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      expect((error as Error).message).toContain('destinations.json');
      expect((error as Error).message).toContain('destinations');
    }
  });

  it('rejects a destination entry missing a required field, at the correct index and position', () => {
    const text = JSON.stringify({
      destinations: [{ id: 'GABC', type: 'account', label: 'clean' }],
    });

    try {
      parseDestinationsFixtureIncremental('destinations.json', text);
      expect.unreachable('parseDestinationsFixtureIncremental should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      const fixtureError = error as FixtureValidationError;
      expect(fixtureError.message).toContain('destinations[0].notes');
      expect(fixtureError.position).toBeDefined();
      expect(fixtureError.position?.offset).toBe(text.indexOf('{"id"'));
    }
  });

  it('rejects an empty-string field', () => {
    const text = JSON.stringify({
      destinations: [{ id: 'GABC', type: 'account', label: '', notes: 'ok' }],
    });

    expect(() => parseDestinationsFixtureIncremental('destinations.json', text)).toThrow(
      FixtureValidationError,
    );
  });

  it('stops at the first malformed entry without scanning entries after it', () => {
    const text = JSON.stringify({
      destinations: [
        { id: 'GABC', type: 'account', label: 'clean' /* missing notes */ },
        { id: 'GDEF', type: 'account', label: 'clean' /* also missing notes */ },
      ],
    });

    try {
      parseDestinationsFixtureIncremental('destinations.json', text);
      expect.unreachable('parseDestinationsFixtureIncremental should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('destinations[0].notes');
      expect((error as Error).message).not.toContain('destinations[1]');
    }
  });

  it('ignores unrecognized extra fields on an entry and at the root', () => {
    const text = JSON.stringify({
      schemaVersion: 3,
      destinations: [{ id: 'GABC', type: 'account', label: 'clean', notes: 'ok', extra: { nested: [1, 2] } }],
    });

    expect(parseDestinationsFixtureIncremental('destinations.json', text)).toEqual({
      destinations: [{ id: 'GABC', type: 'account', label: 'clean', notes: 'ok' }],
    });
  });
});
