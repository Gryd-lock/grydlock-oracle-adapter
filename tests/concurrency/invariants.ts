/**
 * Machine-checkable translations of the prose invariants documented on
 * `CircuitBreakerOracle` and `CoalescingOracle`. These are pure functions
 * (no vitest dependency) so they can be reused both as fuzz-loop assertions
 * and as the `reproduces` predicate the shrinker replays against.
 */
import { CircuitBreakerState } from '../../src/CircuitBreakerOracle';
import { Schedule } from './scheduler';

export interface InvariantViolation {
  name: string;
  detail: string;
}

export type CallerResult =
  { status: 'fulfilled'; value: number } | { status: 'rejected'; reason: unknown };

function settlementKey(result: CallerResult): string {
  if (result.status === 'fulfilled') return `f:${result.value}`;
  const reason = result.reason;
  return `r:${reason instanceof Error ? `${reason.name}:${reason.message}` : String(reason)}`;
}

export interface CircuitBreakerTrace {
  schedule: Schedule;
  /** Caller indices (0-based, in the order they occurred) that made a real downstream call. */
  invocationLog: number[];
  callerResults: CallerResult[];
  finalState: CircuitBreakerState;
}

/**
 * Direct translation of INV1/INV2/INV3 from `src/CircuitBreakerOracle.ts`.
 */
export function checkCircuitBreakerInvariants(trace: CircuitBreakerTrace): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const { schedule, invocationLog, callerResults, finalState } = trace;

  // INV1 — at most one real downstream call per HALF_OPEN episode.
  if (invocationLog.length > 1) {
    violations.push({
      name: 'INV1_SINGLE_PROBE',
      detail: `expected exactly 1 real downstream call while OPEN/HALF_OPEN, got ${invocationLog.length} (caller indices: [${invocationLog.join(', ')}])`,
    });
  }

  // INV2 — a failure outcome from any real probe must never be silently
  // overwritten by a concurrently-resolving success.
  const hasFailure = invocationLog.some((idx) => schedule.outcomes[idx]?.kind === 'failure');
  if (hasFailure && finalState === CircuitBreakerState.CLOSED) {
    violations.push({
      name: 'INV2_FAILURE_DOMINANCE',
      detail: `a real probe reported failure but the final state is CLOSED (a concurrent success overwrote the failure)`,
    });
  }

  // INV3 — corollary of INV1 for the coalescing design choice: every caller
  // admitted into this episode must observe the identical settlement.
  const distinctSettlements = new Set(callerResults.map(settlementKey));
  if (distinctSettlements.size > 1) {
    violations.push({
      name: 'INV3_CONSISTENT_SETTLEMENT',
      detail: `callers disagreed on outcome: [${[...distinctSettlements].join(', ')}]`,
    });
  }

  return violations;
}

export interface CoalescingTrace {
  destination: string;
  innerCallCount: number;
  callerResults: CallerResult[];
  unhandledRejections: unknown[];
}

/** Trace for a CircuitBreakerOracle + CoalescingOracle (+ FallbackOracle) composition. */
export interface CompositionTrace extends CircuitBreakerTrace {
  unhandledRejections: unknown[];
}

/** Union of the CircuitBreakerOracle invariants and the no-unhandled-rejection invariant. */
export function checkCompositionInvariants(trace: CompositionTrace): InvariantViolation[] {
  const violations = checkCircuitBreakerInvariants(trace);
  if (trace.unhandledRejections.length > 0) {
    violations.push({
      name: 'INV_NO_UNHANDLED_REJECTION',
      detail: `${trace.unhandledRejections.length} unhandledRejection event(s) fired during composition run`,
    });
  }
  return violations;
}

/** Direct translation of the INV documented on `src/CoalescingOracle.ts`. */
export function checkCoalescingInvariants(trace: CoalescingTrace): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (trace.unhandledRejections.length > 0) {
    violations.push({
      name: 'INV_NO_UNHANDLED_REJECTION',
      detail: `${trace.unhandledRejections.length} unhandledRejection event(s) fired for destination ${trace.destination}`,
    });
  }

  if (trace.innerCallCount !== 1) {
    violations.push({
      name: 'INV_SINGLE_INFLIGHT_CALL',
      detail: `expected exactly 1 inner call for ${trace.destination}, got ${trace.innerCallCount}`,
    });
  }

  const distinctSettlements = new Set(trace.callerResults.map(settlementKey));
  if (distinctSettlements.size > 1) {
    violations.push({
      name: 'INV_CONSISTENT_SETTLEMENT',
      detail: `callers disagreed on outcome: [${[...distinctSettlements].join(', ')}]`,
    });
  }

  return violations;
}
