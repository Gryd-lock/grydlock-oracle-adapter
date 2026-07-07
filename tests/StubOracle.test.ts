import { describe, expect, it } from 'vitest';
import { StubOracle } from '../src/StubOracle';
import testkitDestinations from '../src/fixtures/testkit/destinations.json';

describe('StubOracle', () => {
  it('returns a score within 0-100 for every grydlock-testkit fixture destination', async () => {
    const oracle = new StubOracle();

    for (const { id } of testkitDestinations.destinations) {
      const score = await oracle.getScore(id);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('scores fixture destinations labelled malicious higher than those labelled clean', async () => {
    const oracle = new StubOracle();

    const cleanScores = await Promise.all(
      testkitDestinations.destinations
        .filter((d) => d.label === 'clean')
        .map((d) => oracle.getScore(d.id)),
    );
    const maliciousScores = await Promise.all(
      testkitDestinations.destinations
        .filter((d) => d.label === 'malicious')
        .map((d) => oracle.getScore(d.id)),
    );

    expect(Math.max(...cleanScores)).toBeLessThan(Math.min(...maliciousScores));
  });

  it('returns the default score for an unrecognized destination', async () => {
    const oracle = new StubOracle();

    const score = await oracle.getScore('GSOMEUNRECOGNIZEDDESTINATION');

    expect(score).toBe(0);
  });
});
