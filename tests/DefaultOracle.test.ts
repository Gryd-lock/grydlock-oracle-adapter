import { describe, expect, it } from 'vitest';
import { DefaultOracle } from '../src/DefaultOracle';

describe('DefaultOracle', () => {
  it('returns zero by default', async () => {
    const oracle = new DefaultOracle();

    await expect(
      oracle.getScore('anything'),
    ).resolves.toBe(0);
  });

  it('returns a configured score', async () => {
    const oracle = new DefaultOracle(42);

    await expect(
      oracle.getScore('anything'),
    ).resolves.toBe(42);
  });
});
