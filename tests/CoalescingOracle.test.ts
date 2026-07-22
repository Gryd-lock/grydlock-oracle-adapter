import { describe, expect, it } from 'vitest';
import { CoalescingOracle } from '../src/CoalescingOracle';
import { RiskOracle } from '../src/RiskOracle';

class ControlledOracle implements RiskOracle {
  public readonly callCountByDestination = new Map<string, number>();

  private readonly resolvers = new Map<
    string,
    {
      resolve: (v: number) => void;
      reject: (e: unknown) => void;
      promise: Promise<number>;
    }
  >();

  getScore(destination: string): Promise<number> {
    this.callCountByDestination.set(
      destination,
      (this.callCountByDestination.get(destination) ?? 0) + 1,
    );

    const existing = this.resolvers.get(destination);
    if (existing) return existing.promise;

    let resolve!: (v: number) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.resolvers.set(destination, { resolve, reject, promise });
    return promise;
  }

  resolve(destination: string, value: number) {
    const entry = this.resolvers.get(destination);
    if (!entry) throw new Error(`No in-flight promise for destination: ${destination}`);
    // Clear the entry so a subsequent getScore for this destination gets a
    // fresh promise rather than this already-settled one.
    this.resolvers.delete(destination);
    entry.resolve(value);
  }

  reject(destination: string, error: unknown) {
    const entry = this.resolvers.get(destination);
    if (!entry) throw new Error(`No in-flight promise for destination: ${destination}`);
    this.resolvers.delete(destination);
    entry.reject(error);
  }
}

describe('CoalescingOracle', () => {
  it('de-duplicates concurrent getScore calls for the same destination', async () => {
    const inner = new ControlledOracle();
    const oracle = new CoalescingOracle(inner);

    const destination = 'DEST_A';
    const N = 25;

    const promises = Array.from({ length: N }, () => oracle.getScore(destination));

    // Underlying should have been called exactly once.
    expect(inner.callCountByDestination.get(destination)).toBe(1);

    // Resolve the single underlying request.
    inner.resolve(destination, 42);

    const results = await Promise.all(promises);
    expect(results).toEqual(Array.from({ length: N }, () => 42));
  });

  it('does not de-duplicate concurrent calls for different destinations', async () => {
    const inner = new ControlledOracle();
    const oracle = new CoalescingOracle(inner);

    const promises = [oracle.getScore('DEST_A'), oracle.getScore('DEST_B')];

    expect(inner.callCountByDestination.get('DEST_A')).toBe(1);
    expect(inner.callCountByDestination.get('DEST_B')).toBe(1);

    inner.resolve('DEST_A', 10);
    inner.resolve('DEST_B', 20);

    const results = await Promise.all(promises);
    expect(results).toEqual([10, 20]);
  });

  it('propagates failure to all awaiting callers for the same destination', async () => {
    const inner = new ControlledOracle();
    const oracle = new CoalescingOracle(inner);

    const destination = 'DEST_A';
    const N = 12;

    const promises = Array.from({ length: N }, () => oracle.getScore(destination));

    const err = new Error('boom');
    inner.reject(destination, err);

    await expect(Promise.all(promises)).rejects.toBe(err);
  });

  it('allows a retry after a failed in-flight request completes', async () => {
    const inner = new ControlledOracle();
    const oracle = new CoalescingOracle(inner);

    const destination = 'DEST_A';

    const p1 = oracle.getScore(destination);
    expect(inner.callCountByDestination.get(destination)).toBe(1);

    const err = new Error('first fail');
    inner.reject(destination, err);
    await expect(p1).rejects.toBe(err);

    const p2 = oracle.getScore(destination);
    expect(inner.callCountByDestination.get(destination)).toBe(2);

    inner.resolve(destination, 99);
    await expect(p2).resolves.toBe(99);
  });
});

