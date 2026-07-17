import { describe, expect, it } from 'vitest';
import {
  FixtureValidationError,
  validateDestinationsFixture,
  validateScoresFixture,
} from '../src/fixtures/testkit/schema';

describe('validateScoresFixture', () => {
  it('accepts a well-formed scores fixture', () => {
    const data = { GABC: 10, GDEF: 90 };

    expect(validateScoresFixture('scores.json', data)).toBe(data);
  });

  it('rejects a truncated fixture (not an object)', () => {
    expect(() => validateScoresFixture('scores.json', null)).toThrow(FixtureValidationError);
    expect(() => validateScoresFixture('scores.json', [])).toThrow(FixtureValidationError);
  });

  it('rejects a non-numeric score with a message naming the file, destination, and value', () => {
    const malformed = { GABC: '10' };

    try {
      validateScoresFixture('scores.json', malformed);
      expect.unreachable('validateScoresFixture should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      expect((error as Error).message).toContain('scores.json');
      expect((error as Error).message).toContain('GABC');
      expect((error as Error).message).toContain('"10"');
    }
  });

  it('rejects a score outside the 0-100 range', () => {
    expect(() => validateScoresFixture('scores.json', { GABC: 101 })).toThrow(
      FixtureValidationError,
    );
    expect(() => validateScoresFixture('scores.json', { GABC: -1 })).toThrow(
      FixtureValidationError,
    );
  });
});

describe('validateDestinationsFixture', () => {
  it('accepts a well-formed destinations fixture', () => {
    const data = {
      destinations: [{ id: 'GABC', type: 'account', label: 'clean', notes: 'ok' }],
    };

    expect(validateDestinationsFixture('destinations.json', data)).toBe(data);
  });

  it('rejects a fixture missing the destinations array (wrong schema version)', () => {
    try {
      validateDestinationsFixture('destinations.json', { entries: [] });
      expect.unreachable('validateDestinationsFixture should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      expect((error as Error).message).toContain('destinations.json');
      expect((error as Error).message).toContain('destinations');
    }
  });

  it('rejects a destination entry missing a required field', () => {
    const malformed = { destinations: [{ id: 'GABC', type: 'account', label: 'clean' }] };

    try {
      validateDestinationsFixture('destinations.json', malformed);
      expect.unreachable('validateDestinationsFixture should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      expect((error as Error).message).toContain('destinations[0].notes');
    }
  });
});
