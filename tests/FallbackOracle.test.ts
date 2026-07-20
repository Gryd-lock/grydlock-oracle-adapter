import { describe, expect, it, vi } from 'vitest';
import { FallbackOracle } from '../src/FallbackOracle';
import { RiskOracle } from '../src/RiskOracle';
import { FallbackObserver } from '../src/FallbackObserver';

class FakeOracle implements RiskOracle {
  constructor(
    private readonly fn: (destination: string) => Promise<number>,
  ) {}

  getScore(destination: string): Promise<number> {
    return this.fn(destination);
  }
}

describe('FallbackOracle', () => {
  it('uses the first oracle when it succeeds', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => 10),
      new FakeOracle(async () => 99),
    ]);

    await expect(
      oracle.getScore('destination'),
    ).resolves.toBe(10);
  });

  it('falls back to the second oracle', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => {
        throw new Error('Soroban failed');
      }),
      new FakeOracle(async () => 42),
    ]);

    await expect(
      oracle.getScore('destination'),
    ).resolves.toBe(42);
  });

  it('falls back through multiple failed tiers', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => {
        throw new Error('Soroban failed');
      }),
      new FakeOracle(async () => {
        throw new Error('Cache failed');
      }),
      new FakeOracle(async () => 77),
    ]);

    await expect(
      oracle.getScore('destination'),
    ).resolves.toBe(77);
  });

  it('throws when every oracle fails', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => {
        throw new Error('One');
      }),
      new FakeOracle(async () => {
        throw new Error('Two');
      }),
    ]);

    await expect(
      oracle.getScore('destination'),
    ).rejects.toThrow('Two');
  });

  it('throws when no oracles are configured', async () => {
    const oracle = new FallbackOracle([]);

    await expect(
      oracle.getScore('destination'),
    ).rejects.toThrow('FallbackOracle has no configured oracles.');
  });

  it('notifies the observer for each failed fallback', async () => {
    const observer: FallbackObserver = {
      onFallback: vi.fn(),
    };

    const oracle = new FallbackOracle(
      [
        new FakeOracle(async () => {
          throw new Error('one');
        }),
        new FakeOracle(async () => {
          throw new Error('two');
        }),
        new FakeOracle(async () => 88),
      ],
      observer,
    );

    await expect(
      oracle.getScore('destination'),
    ).resolves.toBe(88);

    expect(observer.onFallback).toHaveBeenCalledTimes(2);
  });
});
