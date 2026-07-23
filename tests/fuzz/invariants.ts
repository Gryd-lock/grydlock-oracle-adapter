import { CircuitBreakerState } from '../../src/CircuitBreakerOracle';
import { Harness } from './harness';
import { CallerOutcomeKind } from './schedule';
import { FuzzTrace } from './runner';

export interface InvariantViolation {
  id: string;
  message: string;
  detail?: unknown;
}

export type InvariantCheck = (harness: Harness, trace: FuzzTrace) => InvariantViolation[];

function outcomeForCallId(trace: FuzzTrace, callId: number): CallerOutcomeKind {
  const owner = trace.callerOwnCallId.findIndex((id) => id === callId);
  return owner === -1 ? 'success' : trace.spec.callers[owner].outcome;
}

/**
 * INV-CB-1 (single-flight probe), CONCURRENCY_INVARIANTS.md section 2:
 * "at most one call to `this.oracle.getScore` is ever in flight while
 * `state === HALF_OPEN`". Checked here as: among all real underlying calls
 * issued while the breaker's state was HALF_OPEN, no more than one is
 * attributed to the same OPEN->HALF_OPEN transition ("generation").
 */
export const checkInvCB1: InvariantCheck = (harness) => {
  if (!harness.cb) return [];
  const byGeneration = new Map<number, number>();
  for (const call of harness.spyCalls) {
    if (call.stateAtIssue !== CircuitBreakerState.HALF_OPEN) continue;
    byGeneration.set(call.generationAtIssue, (byGeneration.get(call.generationAtIssue) ?? 0) + 1);
  }
  const violations: InvariantViolation[] = [];
  for (const [gen, count] of byGeneration) {
    if (count > 1) {
      violations.push({
        id: 'INV-CB-1',
        message: `${count} underlying calls issued while HALF_OPEN in generation ${gen} (expected <= 1): thundering herd.`,
        detail: { generation: gen, count },
      });
    }
  }
  return violations;
};

/**
 * INV-CB-3 (deterministic settlement / failure-dominance),
 * CONCURRENCY_INVARIANTS.md section 2: a probe failure is never silently overwritten by
 * a concurrently-resolving success. Checked *per generation*, not against
 * the run's final state: a later, independent HALF_OPEN generation is
 * allowed to legitimately re-close the breaker after an earlier generation
 * correctly reopened it — that is two sequential, correctly-resolved
 * cycles, not an erasure. What would actually be an erasure is generation
 * G's own HALF_OPEN period failing to exit to OPEN when its probe failed
 * with an infrastructure error — i.e. some *other* concurrent activity
 * (which INV-CB-1 already forbids) overwrote it before its own failure
 * could apply. This is checked directly against `harness.transitions`, the
 * ground-truth log of every `state` assignment (see `instrumentGeneration`
 * in harness.ts): generation G's exit transition is the state-assignment
 * immediately following its entry into HALF_OPEN.
 */
export const checkInvCB3: InvariantCheck = (harness, trace) => {
  if (!harness.cb) return [];
  const violations: InvariantViolation[] = [];

  for (const call of harness.spyCalls) {
    if (call.stateAtIssue !== CircuitBreakerState.HALF_OPEN) continue;
    const outcome = outcomeForCallId(trace, call.id);
    if (outcome !== 'infra-fail') continue;

    const entryIndex = harness.transitions.findIndex(
      (t) => t.generation === call.generationAtIssue && t.to === CircuitBreakerState.HALF_OPEN,
    );
    const exit = entryIndex !== -1 ? harness.transitions[entryIndex + 1] : undefined;
    if (!exit || exit.generation !== call.generationAtIssue) continue; // not yet settled or unexpected shape; nothing to check.

    if (exit.to !== CircuitBreakerState.OPEN) {
      violations.push({
        id: 'INV-CB-3',
        message: `Probe (call ${call.id}, generation ${call.generationAtIssue}) failed with an infra error, but its own HALF_OPEN cycle exited to ${exit.to} instead of OPEN.`,
        detail: { callId: call.id, generation: call.generationAtIssue, exit },
      });
    }
  }
  return violations;
};

/**
 * INV-CB-4 (per-destination correctness / linearizability),
 * CONCURRENCY_INVARIANTS.md section 2: a caller for destination X never
 * receives a score that was actually produced by a real underlying call
 * issued for a different destination. `ManualOracle` resolves every call
 * with `value === callId`, so this is checked by tracing each successful
 * result's value back to the `callLog` entry for that id and comparing
 * destinations.
 */
export const checkInvCB4: InvariantCheck = (harness, trace) => {
  const violations: InvariantViolation[] = [];
  for (const result of trace.results) {
    if (!result.settled || result.ok !== true || result.value === undefined) continue;
    const logEntry = harness.callLog().find((e) => e.id === result.value);
    if (!logEntry) {
      violations.push({
        id: 'INV-CB-4',
        message: `Caller ${result.caller} (destination ${result.destination}) resolved with value ${result.value}, which does not correspond to any real underlying call.`,
        detail: { caller: result.caller },
      });
      continue;
    }
    if (logEntry.destination !== result.destination) {
      violations.push({
        id: 'INV-CB-4',
        message: `Caller ${result.caller} asked for destination "${result.destination}" but got the score for "${logEntry.destination}" (call ${logEntry.id}).`,
        detail: {
          caller: result.caller,
          expected: result.destination,
          actual: logEntry.destination,
        },
      });
    }
  }
  return violations;
};

/**
 * INV-CO-1 (no floating rejection), CONCURRENCY_INVARIANTS.md section
 * 3: `CoalescingOracle` must never cause Node's `unhandledRejection` to
 * fire, for any success/failure pattern or settlement order.
 */
export const checkInvCO1: InvariantCheck = (_harness, trace) => {
  if (trace.unhandledRejections.length === 0) return [];
  return [
    {
      id: 'INV-CO-1',
      message: `${trace.unhandledRejections.length} unhandledRejection event(s) fired during this schedule.`,
      detail: trace.unhandledRejections.map((e) => (e instanceof Error ? e.message : String(e))),
    },
  ];
};

/**
 * INV-CO-2 (single underlying call per destination),
 * CONCURRENCY_INVARIANTS.md section 3: while `CoalescingOracle` is part of the SUT, at
 * no point should two real underlying calls for the same destination be
 * simultaneously pending. `ManualOracle` records this in real time (see
 * `concurrentPendingConflicts`) as it happens, rather than trying to
 * reconstruct concurrency windows after the fact from a settlement log.
 */
export const checkInvCO2: InvariantCheck = (harness) => {
  if (!harness.co) return [];
  return harness.manual.concurrentPendingConflicts.map((conflict) => ({
    id: 'INV-CO-2',
    message: `${conflict.ids.length} real underlying calls for destination "${conflict.destination}" were simultaneously pending (ids ${conflict.ids.join(', ')}): CoalescingOracle failed to de-duplicate.`,
    detail: conflict,
  }));
};

export const ALL_INVARIANTS: InvariantCheck[] = [
  checkInvCB1,
  checkInvCB3,
  checkInvCB4,
  checkInvCO1,
  checkInvCO2,
];
