import { RiskOracle } from '../../src/RiskOracle';

/**
 * Error type used for scheduled failures. Carries the underlying call id and
 * destination so invariant checks can trace a caller's observed rejection
 * back to the exact `ManualOracle` call that produced it.
 */
export type FailureKind = 'infra' | 'logic';

export class ScheduledError extends Error {
  constructor(
    public readonly callId: number,
    public readonly destination: string,
    public readonly failureKind: FailureKind,
  ) {
    super(`scheduled-${failureKind}-failure:${callId}:${destination}`);
    this.name = 'ScheduledError';
  }
}

interface PendingEntry {
  destination: string;
  resolve: (v: number) => void;
  reject: (e: unknown) => void;
}

export interface CallLogEntry {
  id: number;
  destination: string;
}

/**
 * A `RiskOracle` whose promises are only ever settled explicitly, by id, via
 * `settle()`. This is the fuzzer's "controllable mock promise": it never
 * uses real timers, so the schedule generator (not the OS or a clock) fully
 * determines settlement order.
 *
 * Every successful settlement resolves with `value === callId`, and every
 * failed settlement rejects with a `ScheduledError` carrying `callId` and
 * `destination`. This makes result *attribution* trivial for invariant
 * checks (INV-CB-4, INV-CO-2): a caller's observed value/error can always be
 * traced back to exactly which real underlying call produced it, and for
 * which destination.
 */
export interface ConcurrentPendingConflict {
  destination: string;
  /** Ids that were simultaneously pending for this destination at issuance time. */
  ids: number[];
}

export class ManualOracle implements RiskOracle {
  private nextId = 0;
  readonly pending = new Map<number, PendingEntry>();
  readonly callLog: CallLogEntry[] = [];
  /**
   * Populated in real time (not reconstructed after the fact): whenever a
   * new call is issued for a destination that already has an unsettled
   * pending call, that's ground truth evidence two real underlying calls
   * for the same destination were in flight at once — exactly what
   * `CoalescingOracle` exists to prevent (INV-CO-2).
   */
  readonly concurrentPendingConflicts: ConcurrentPendingConflict[] = [];

  getScore(destination: string): Promise<number> {
    const id = this.nextId++;
    this.callLog.push({ id, destination });
    const alreadyPending = this.pendingIdsFor(destination);
    if (alreadyPending.length > 0) {
      this.concurrentPendingConflicts.push({ destination, ids: [...alreadyPending, id] });
    }
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { destination, resolve, reject });
    });
  }

  /** Pending call ids for a given destination, in issuance order. */
  pendingIdsFor(destination: string): number[] {
    return [...this.pending.entries()]
      .filter(([, e]) => e.destination === destination)
      .map(([id]) => id);
  }

  settle(id: number, outcome: { ok: true } | { ok: false; failureKind: FailureKind }): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error(`ManualOracle: no pending call ${id}`);
    this.pending.delete(id);
    if (outcome.ok) {
      entry.resolve(id);
    } else {
      entry.reject(new ScheduledError(id, entry.destination, outcome.failureKind));
    }
  }
}
