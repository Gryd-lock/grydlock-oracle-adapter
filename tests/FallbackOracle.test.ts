import { describe, expect, it, vi } from 'vitest';
import { FallbackOracle } from '../src/FallbackOracle';
import { RiskOracle } from '../src/RiskOracle';
import { FallbackObserver } from '../src/FallbackObserver';
import { CancellableRiskOracle } from '../src/CancellableRiskOracle';
import { OracleCancelledError } from '../src/OracleError';

class FakeOracle implements RiskOracle {
  constructor(private readonly fn: (destination: string) => Promise<number>) {}

  getScore(destination: string): Promise<number> {
    return this.fn(destination);
  }
}

/** Cancellable tier that never settles on its own — only on abort. */
class NeverSettlingCancellableOracle implements CancellableRiskOracle {
  public callCount = 0;

  async getScore(): Promise<number> {
    throw new Error('not used in these tests');
  }

  getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
    this.callCount++;
    return new Promise<number>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new OracleCancelledError('cancelled', { destination })),
        { once: true },
      );
    });
  }
}

describe('FallbackOracle', () => {
  it('uses the first oracle when it succeeds', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => 10),
      new FakeOracle(async () => 99),
    ]);

    await expect(oracle.getScore('destination')).resolves.toBe(10);
  });

  it('falls back to the second oracle', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => {
        throw new Error('Soroban failed');
      }),
      new FakeOracle(async () => 42),
    ]);

    await expect(oracle.getScore('destination')).resolves.toBe(42);
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

    await expect(oracle.getScore('destination')).resolves.toBe(77);
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

    await expect(oracle.getScore('destination')).rejects.toThrow('Two');
  });

  it('throws when no oracles are configured', async () => {
    const oracle = new FallbackOracle([]);

    await expect(oracle.getScore('destination')).rejects.toThrow(
      'FallbackOracle has no configured oracles.',
    );
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

    await expect(oracle.getScore('destination')).resolves.toBe(88);

    expect(observer.onFallback).toHaveBeenCalledTimes(2);
  });
});

describe('FallbackOracle: cancellation (issue #98)', () => {
  it('aborts the whole chain instead of falling through to the next tier', async () => {
    const tier1 = new NeverSettlingCancellableOracle();
    const tier2 = new FakeOracle(async () => 5);
    const oracle = new FallbackOracle([tier1, tier2]);

    const ctrl = new AbortController();
    const pending = oracle.getScoreCancellable('destination', ctrl.signal);
    ctrl.abort();

    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
  });

  it('lets the caller bail out even when the in-flight tier is not itself cancellable', async () => {
    let resolveTier1!: (v: number) => void;
    const tier1 = new FakeOracle(
      () =>
        new Promise<number>((resolve) => {
          resolveTier1 = resolve;
        }),
    );
    const oracle = new FallbackOracle([tier1]);

    const ctrl = new AbortController();
    const pending = oracle.getScoreCancellable('destination', ctrl.signal);
    ctrl.abort();

    await expect(pending).rejects.toBeInstanceOf(OracleCancelledError);
    resolveTier1(1); // let it settle later so nothing dangles
  });

  it('rejects immediately for an already-aborted signal without trying any tier', async () => {
    const tier1 = new NeverSettlingCancellableOracle();
    const oracle = new FallbackOracle([tier1]);

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(oracle.getScoreCancellable('destination', ctrl.signal)).rejects.toBeInstanceOf(
      OracleCancelledError,
    );
    expect(tier1.callCount).toBe(0);
  });

  it('still falls through to the next tier on a genuine (non-cancellation) failure', async () => {
    const oracle = new FallbackOracle([
      new FakeOracle(async () => {
        throw new Error('real failure');
      }),
      new FakeOracle(async () => 9),
    ]);

    const ctrl = new AbortController();
    await expect(oracle.getScoreCancellable('destination', ctrl.signal)).resolves.toBe(9);
  });
});
