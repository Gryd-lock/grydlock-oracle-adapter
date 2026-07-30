import { RiskOracle } from '../../src/RiskOracle';
import {
  CircuitBreakerOracle,
  CircuitBreakerConfig,
  CircuitBreakerState,
} from '../../src/CircuitBreakerOracle';
import { CoalescingOracle } from '../../src/CoalescingOracle';
import { ManualOracle, CallLogEntry } from './manualOracle';

export type SutKind = 'cb-only' | 'co-only' | 'cb-outer-co-inner' | 'co-outer-cb-inner';

export interface SpyCall {
  id: number;
  destination: string;
  /** CircuitBreakerOracle.getState() at the instant this call was issued, or null when no CB is present. */
  stateAtIssue: CircuitBreakerState | null;
  /** Which HALF_OPEN "generation" (count of OPEN->HALF_OPEN transitions observed so far) this call belongs to. */
  generationAtIssue: number;
}

export interface Harness {
  kind: SutKind;
  sut: RiskOracle;
  manual: ManualOracle;
  cb: CircuitBreakerOracle | null;
  co: CoalescingOracle | null;
  spyCalls: SpyCall[];
  callLog: () => readonly CallLogEntry[];
  /** Full state-transition log for `cb` (see `instrumentGeneration`), or empty when no CB is present. */
  transitions: StateTransition[];
}

export const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 2,
  // 0 cooldown: the fuzzer never needs to fast-forward a clock, cooldown is
  // "already elapsed" the instant the breaker trips, so the interesting
  // HALF_OPEN concurrency window is reachable without fake timers.
  cooldownWindow: 0,
  isInfrastructureError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'ScheduledError' &&
    (error as { failureKind?: string }).failureKind === 'infra',
};

export interface StateTransition {
  generation: number;
  from: CircuitBreakerState;
  to: CircuitBreakerState;
}

export interface GenerationTracker {
  getState: () => CircuitBreakerState;
  getGeneration: () => number;
  /** Every assignment to `state`, in order, each tagged with the HALF_OPEN generation it belongs to. */
  transitions: StateTransition[];
}

/**
 * Instruments a `CircuitBreakerOracle` (or `BuggyCircuitBreakerOracle`, same
 * field name) to record every assignment to its private `state` field, by
 * intercepting the field via `Object.defineProperty` (TypeScript `private`
 * is compile-time only; at runtime `state` is a normal own property).
 *
 * The generation counter exists because `cooldownWindow: 0` (used
 * throughout the fuzzer so no fake timers are needed) makes a *second,
 * independent, sequential* HALF_OPEN probe eligible to start immediately
 * after the first one fails — a different caller's own retry, correctly
 * single-flight, just densely packed in time. A counter that only samples
 * state when the spy happens to be called cannot always distinguish that
 * from a single generation with two concurrent probes, because the
 * intervening OPEN state may never trigger a spy call before the next
 * HALF_OPEN transition. Direct field interception has no such blind spot:
 * every write to `state` is observed as it happens, synchronously.
 *
 * The full `transitions` log (not just the counter) is what lets INV-CB-3
 * be checked *per generation* rather than against the run's final state:
 * a later, independent generation is allowed to re-close the breaker after
 * an earlier one legitimately reopened it — that is not an "erasure", it's
 * two sequential, correctly-resolved HALF_OPEN cycles.
 */
export function instrumentGeneration(cb: object): GenerationTracker {
  let generation = 0;
  let current = (cb as { state: CircuitBreakerState }).state;
  const transitions: StateTransition[] = [];
  Object.defineProperty(cb, 'state', {
    get(): CircuitBreakerState {
      return current;
    },
    set(next: CircuitBreakerState) {
      if (next === CircuitBreakerState.HALF_OPEN && current !== CircuitBreakerState.HALF_OPEN) {
        generation++;
      }
      transitions.push({ generation, from: current, to: next });
      current = next;
    },
    configurable: true,
    enumerable: true,
  });
  return { getState: () => current, getGeneration: () => generation, transitions };
}

/**
 * Wraps the immediate `next` oracle passed to a CircuitBreakerOracle with a
 * spy that records, for every call, the breaker's state and HALF_OPEN
 * generation (see `instrumentGeneration`) *at the instant the call was
 * issued* (synchronously, before delegating) — this is the raw data
 * INV-CB-1 and INV-CB-3 are checked against.
 */
export function spyOn(
  inner: RiskOracle,
  spyCalls: SpyCall[],
  tracker: Pick<GenerationTracker, 'getState' | 'getGeneration'> | null,
): RiskOracle {
  return {
    getScore(destination: string): Promise<number> {
      const state = tracker ? tracker.getState() : null;
      const generation = tracker ? tracker.getGeneration() : 0;
      spyCalls.push({
        id: spyCalls.length,
        destination,
        stateAtIssue: state,
        generationAtIssue: generation,
      });
      return inner.getScore(destination);
    },
  };
}

export function buildHarness(kind: SutKind, cbConfig: Partial<CircuitBreakerConfig> = {}): Harness {
  const manual = new ManualOracle();
  const spyCalls: SpyCall[] = [];
  const config: CircuitBreakerConfig = { ...DEFAULT_CB_CONFIG, ...cbConfig };

  switch (kind) {
    case 'cb-only': {
      // `box` breaks the construction cycle: the spy needs a tracker
      // accessor, but the tracker can only be created once the
      // CircuitBreakerOracle instance exists, and that instance's
      // constructor needs the already-spied oracle. The accessor closures
      // read `box.current` lazily, so they only need it populated by the
      // time a real call happens, not at construction time.
      const box: { current: GenerationTracker | null } = { current: null };
      const spied = spyOn(manual, spyCalls, {
        getState: () => box.current!.getState(),
        getGeneration: () => box.current!.getGeneration(),
      });
      const cb = new CircuitBreakerOracle(spied, config);
      box.current = instrumentGeneration(cb);
      return {
        kind,
        sut: cb,
        manual,
        cb,
        co: null,
        spyCalls,
        callLog: () => manual.callLog,
        transitions: box.current.transitions,
      };
    }
    case 'co-only': {
      const spied = spyOn(manual, spyCalls, null);
      const co = new CoalescingOracle(spied);
      return {
        kind,
        sut: co,
        manual,
        cb: null,
        co,
        spyCalls,
        callLog: () => manual.callLog,
        transitions: [],
      };
    }
    case 'cb-outer-co-inner': {
      // CircuitBreakerOracle(CoalescingOracle(spy(manual)))
      const box: { current: GenerationTracker | null } = { current: null };
      const spied = spyOn(manual, spyCalls, {
        getState: () => box.current!.getState(),
        getGeneration: () => box.current!.getGeneration(),
      });
      const co = new CoalescingOracle(spied);
      const cb = new CircuitBreakerOracle(co, config);
      box.current = instrumentGeneration(cb);
      return {
        kind,
        sut: cb,
        manual,
        cb,
        co,
        spyCalls,
        callLog: () => manual.callLog,
        transitions: box.current.transitions,
      };
    }
    case 'co-outer-cb-inner': {
      // CoalescingOracle(CircuitBreakerOracle(spy(manual)))
      const box: { current: GenerationTracker | null } = { current: null };
      const spied = spyOn(manual, spyCalls, {
        getState: () => box.current!.getState(),
        getGeneration: () => box.current!.getGeneration(),
      });
      const cb = new CircuitBreakerOracle(spied, config);
      box.current = instrumentGeneration(cb);
      const co = new CoalescingOracle(cb);
      return {
        kind,
        sut: co,
        manual,
        cb,
        co,
        spyCalls,
        callLog: () => manual.callLog,
        transitions: box.current.transitions,
      };
    }
  }
}
