import { ScheduleSpec, planSchedule } from './schedule';
import { Harness } from './harness';

const WARMUP_DESTINATION = '__warmup__';

export interface CallerResult {
  caller: number;
  destination: string;
  settled: boolean;
  ok?: boolean;
  value?: number;
  error?: unknown;
}

export interface FuzzTrace {
  spec: ScheduleSpec;
  results: CallerResult[];
  /** callerOwnCallId[i] = the underlying call id attributed to caller i's own real (first) underlying call, or null if never issued/attributed. */
  callerOwnCallId: (number | null)[];
  unhandledRejections: unknown[];
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const MAX_CLEANUP_ROUNDS = 200;

/**
 * Executes a schedule spec against a harness, driving the concrete
 * Launch/Settle/Drain steps `planSchedule` derives from it. Deterministic:
 * the same spec + harness construction always produces the same trace.
 *
 * Ownership of real underlying calls is tracked continuously, not just at
 * the instant each caller launches: a HALF_OPEN late-arrival's own retry is
 * issued *asynchronously*, after it recurses once the probe it waited on
 * settles, so its real call may only appear after a later `drain`. Each
 * step attributes any newly-observed underlying call to the
 * lowest-indexed already-launched caller that doesn't own one yet — this is
 * what lets `spec.callers[i].outcome` still apply correctly to that
 * caller's real attempt even though it happens well after its `launch`
 * step, instead of being silently overridden by the cleanup phase.
 *
 * After the planned steps run out, any still-outstanding calls are drained
 * and settled according to whichever caller owns them (falling back to
 * success only for a call nobody claims, which should not normally happen
 * once warmup calls have already fully settled beforehand).
 */
export async function runSchedule(harness: Harness, spec: ScheduleSpec): Promise<FuzzTrace> {
  const steps = planSchedule(spec);
  const k = spec.callers.length;
  const results: CallerResult[] = spec.callers.map((c, i) => ({
    caller: i,
    destination: c.destination,
    settled: false,
  }));
  const callerOwnCallId: (number | null)[] = new Array(k).fill(null);
  const launched = new Array<boolean>(k).fill(false);
  const unhandledRejections: unknown[] = [];
  let nextUnattributedLogIndex = 0;

  const attributeNewCalls = (): void => {
    while (nextUnattributedLogIndex < harness.manual.callLog.length) {
      const entry = harness.manual.callLog[nextUnattributedLogIndex];
      nextUnattributedLogIndex++;
      const owner = callerOwnCallId.findIndex((id, idx) => id === null && launched[idx]);
      if (owner !== -1) callerOwnCallId[owner] = entry.id;
    }
  };

  const settleForOwner = (ownerIndex: number, id: number): void => {
    const outcome = spec.callers[ownerIndex].outcome;
    harness.manual.settle(
      id,
      outcome === 'success'
        ? { ok: true }
        : { ok: false, failureKind: outcome === 'infra-fail' ? 'infra' : 'logic' },
    );
  };

  const onUnhandled = (err: unknown) => unhandledRejections.push(err);
  process.on('unhandledRejection', onUnhandled);

  try {
    for (let w = 0; w < spec.warmupFailures; w++) {
      const before = harness.manual.callLog.length;
      const p = harness.sut.getScore(WARMUP_DESTINATION);
      const guarded = p.catch(() => undefined);
      const after = harness.manual.callLog.length;
      if (after === before + 1) {
        harness.manual.settle(harness.manual.callLog[after - 1].id, {
          ok: false,
          failureKind: 'infra',
        });
      }
      await guarded;
    }
    // Warmup calls are never attributed to a concurrent-phase caller.
    nextUnattributedLogIndex = harness.manual.callLog.length;

    for (const step of steps) {
      if (step.kind === 'drain') {
        await drainMicrotasks();
        attributeNewCalls();
        continue;
      }

      if (step.kind === 'launch') {
        const i = step.caller;
        const callerSpec = spec.callers[i];
        const p = harness.sut.getScore(callerSpec.destination);
        p.then(
          (v) => {
            results[i].settled = true;
            results[i].ok = true;
            results[i].value = v;
          },
          (e) => {
            results[i].settled = true;
            results[i].ok = false;
            results[i].error = e;
          },
        );
        launched[i] = true;
        attributeNewCalls();
        continue;
      }

      if (step.kind === 'settle') {
        const i = step.caller;
        const id = callerOwnCallId[i];
        if (id !== null && harness.manual.pending.has(id)) {
          settleForOwner(i, id);
        }
        attributeNewCalls();
        continue;
      }
    }

    let rounds = 0;
    while (results.some((r) => !r.settled) && rounds++ < MAX_CLEANUP_ROUNDS) {
      await drainMicrotasks();
      attributeNewCalls();
      for (const id of [...harness.manual.pending.keys()].sort((a, b) => a - b)) {
        if (!harness.manual.pending.has(id)) continue;
        const owner = callerOwnCallId.findIndex((ownedId) => ownedId === id);
        if (owner !== -1) {
          settleForOwner(owner, id);
        } else {
          harness.manual.settle(id, { ok: true });
        }
      }
    }
    await drainMicrotasks();
    attributeNewCalls();
    await drainMicrotasks();

    if (results.some((r) => !r.settled)) {
      throw new Error(
        `runSchedule: ${results.filter((r) => !r.settled).length} caller(s) never settled after ${MAX_CLEANUP_ROUNDS} cleanup rounds — likely a genuine deadlock, not a fuzzer bug.`,
      );
    }

    return { spec, results, callerOwnCallId, unhandledRejections };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}
