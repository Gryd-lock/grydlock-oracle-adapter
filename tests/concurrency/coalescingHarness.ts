import { RiskOracle } from '../../src/RiskOracle';
import { CoalescingOracle } from '../../src/CoalescingOracle';
import { createDeferred, executeSchedule, Schedule, tick } from './scheduler';
import { CallerResult, CoalescingTrace } from './invariants';

export type CoalescingFactory = (inner: RiskOracle) => RiskOracle;

export const fixedFactory: CoalescingFactory = (inner) => new CoalescingOracle(inner);

/**
 * Faithful reintroduction of the pre-fix `CoalescingOracle.getScore` (the
 * exact code at the parent of commit `f8290eb`): a floating
 * `p.catch(err => { ...; throw err; })` that produces a second, never-
 * observed rejected promise whenever the inner call fails. Test-only, never
 * exported from `src/`. Used solely to prove the fuzzer catches Bug A.
 */
export class BuggyCoalescingOracle implements RiskOracle {
  private readonly inFlightByDestination = new Map<string, Promise<number>>();

  constructor(private readonly inner: RiskOracle) {}

  async getScore(destination: string): Promise<number> {
    const existing = this.inFlightByDestination.get(destination);
    if (existing) {
      return existing;
    }

    const p = this.inner.getScore(destination);
    this.inFlightByDestination.set(destination, p);

    p.finally(() => {
      if (this.inFlightByDestination.get(destination) === p) {
        this.inFlightByDestination.delete(destination);
      }
    });

    p.catch((err) => {
      throw err;
    });

    return p;
  }
}

/** Waits long enough for Node's unhandledRejection detection to have fired for any settled-this-turn rejection. */
async function flushUnhandledRejections(): Promise<void> {
  await tick(4);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Dispatches `schedule.numCallers` concurrent callers at the same
 * `destination` through `factory(inner)`, settles the single resulting
 * inner call per `schedule.outcomes[0]`, and returns a trace including any
 * `process.on('unhandledRejection', ...)` events observed by `collector`
 * during the run (the caller installs/tears down that listener so many
 * iterations can share one listener).
 */
export async function runCoalescingSchedule(
  factory: CoalescingFactory,
  schedule: Schedule,
  collector: unknown[],
): Promise<CoalescingTrace> {
  const destination = 'fuzz-dest';
  let innerCallCount = 0;
  const deferred = createDeferred<number>();

  const inner: RiskOracle = {
    async getScore(): Promise<number> {
      innerCallCount++;
      return deferred.promise;
    },
  };

  const oracle = factory(inner);

  const before = collector.length;

  const callerPromises = Array.from({ length: schedule.numCallers }, () =>
    oracle.getScore(destination).then(
      (value): CallerResult => ({ status: 'fulfilled', value }),
      (reason): CallerResult => ({ status: 'rejected', reason }),
    ),
  );

  await executeSchedule(schedule, [deferred], [0]);
  const callerResults = await Promise.all(callerPromises);

  await flushUnhandledRejections();

  return {
    destination,
    innerCallCount,
    callerResults,
    unhandledRejections: collector.slice(before),
  };
}
