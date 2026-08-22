import { describe, expect, it } from 'vitest';
import { CoalescingOracle } from '../src/CoalescingOracle';
import { RiskOracle } from '../src/RiskOracle';
import { CancellableRiskOracle } from '../src/CancellableRiskOracle';
import { OracleCancelledError } from '../src/OracleError';

/** Cancellable test double: settles only when resolved/rejected, and reports whether its signal fired. */
class ControlledCancellableOracle implements CancellableRiskOracle {
  public callCount = 0;
  public lastSignal: AbortSignal | undefined;

  private resolveFn?: (v: number) => void;
  private rejectFn?: (e: unknown) => void;

  async getScore(): Promise<number> {
    throw new Error('not used in these tests');
  }

  getScoreCancellable(destination: string, signal: AbortSignal): Promise<number> {
    this.callCount++;
    this.lastSignal = signal;
    return new Promise<number>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
      signal.addEventListener(
        'abort',
        () => reject(new OracleCancelledError('cancelled', { destination })),
        { once: true },
      );
    });
  }

  resolve(value: number): void {
    this.resolveFn?.(value);
  }
}

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

describe('CoalescingOracle: cancellation (issue #98)', () => {
  it('rejects only the cancelling caller, leaving other coalesced callers unaffected', async () => {
    const inner = new ControlledCancellableOracle();
    const oracle = new CoalescingOracle(inner);
    const destination = 'DEST_A';

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const pA = oracle.getScoreCancellable(destination, ctrlA.signal);
    const pB = oracle.getScoreCancellable(destination, ctrlB.signal);

    ctrlA.abort();
    await expect(pA).rejects.toBeInstanceOf(OracleCancelledError);

    expect(inner.lastSignal?.aborted).toBe(false);

    inner.resolve(42);
    await expect(pB).resolves.toBe(42);
    expect(inner.callCount).toBe(1);
  });

  it('actually aborts the shared underlying call once every coalesced caller has cancelled', async () => {
    const inner = new ControlledCancellableOracle();
    const oracle = new CoalescingOracle(inner);
    const destination = 'DEST_A';

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const pA = oracle.getScoreCancellable(destination, ctrlA.signal);
    const pB = oracle.getScoreCancellable(destination, ctrlB.signal);

    ctrlA.abort();
    expect(inner.lastSignal?.aborted).toBe(false);
    ctrlB.abort();
    expect(inner.lastSignal?.aborted).toBe(true);

    await expect(pA).rejects.toBeInstanceOf(OracleCancelledError);
    await expect(pB).rejects.toBeInstanceOf(OracleCancelledError);
    expect(inner.callCount).toBe(1);
  });

  it('starts a genuinely fresh call for a new caller after full cancellation, not a coalesce onto the aborted one', async () => {
    const inner = new ControlledCancellableOracle();
    const oracle = new CoalescingOracle(inner);
    const destination = 'DEST_A';

    const ctrlA = new AbortController();
    const pA = oracle.getScoreCancellable(destination, ctrlA.signal);
    ctrlA.abort();
    await expect(pA).rejects.toBeInstanceOf(OracleCancelledError);
    expect(inner.callCount).toBe(1);

    const ctrlC = new AbortController();
    const pC = oracle.getScoreCancellable(destination, ctrlC.signal);
    expect(inner.callCount).toBe(2);
    inner.resolve(7);
    await expect(pC).resolves.toBe(7);
  });

  it('rejects immediately for a signal that is already aborted, without calling the inner oracle', async () => {
    const inner = new ControlledCancellableOracle();
    const oracle = new CoalescingOracle(inner);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(oracle.getScoreCancellable('DEST_A', ctrl.signal)).rejects.toBeInstanceOf(
      OracleCancelledError,
    );
    expect(inner.callCount).toBe(0);
  });

  it('produces no unhandled rejection across a mix of cancelled and completed coalesced callers', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const inner = new ControlledCancellableOracle();
      const oracle = new CoalescingOracle(inner);
      const destination = 'DEST_A';

      const ctrlA = new AbortController();
      const ctrlB = new AbortController();
      const ctrlC = new AbortController();
      const pA = oracle.getScoreCancellable(destination, ctrlA.signal);
      const pB = oracle.getScoreCancellable(destination, ctrlB.signal);
      const pC = oracle.getScoreCancellable(destination, ctrlC.signal);

      ctrlA.abort();
      inner.resolve(3);

      await Promise.allSettled([pA, pB, pC]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('regression: a new caller coalesces onto a still-running orphaned call when the inner is not cancellable', async () => {
    // The inner here is a plain RiskOracle (no getScoreCancellable), so
    // controller.abort() can never actually stop its real call — cancelling
    // every attached caller only detaches interest, it does not free the
    // resource. A caller arriving after that point must coalesce onto the
    // still-running orphaned call rather than starting a wasteful duplicate.
    const inner = new ControlledOracle();
    const oracle = new CoalescingOracle(inner);
    const destination = 'DEST_A';

    const ctrlA = new AbortController();
    const pA = oracle.getScoreCancellable(destination, ctrlA.signal);
    ctrlA.abort();
    await expect(pA).rejects.toBeInstanceOf(OracleCancelledError);
    expect(inner.callCountByDestination.get(destination)).toBe(1);

    const ctrlC = new AbortController();
    const pC = oracle.getScoreCancellable(destination, ctrlC.signal);
    expect(inner.callCountByDestination.get(destination)).toBe(1); // no second call yet

    inner.resolve(destination, 123);
    await expect(pC).resolves.toBe(123);
    expect(inner.callCountByDestination.get(destination)).toBe(1); // still just the one real call
  });
});
