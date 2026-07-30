import { Rng, mulberry32, rngInt } from './rng';

export type CallerOutcomeKind = 'success' | 'infra-fail' | 'logic-fail';

export interface CallerSpec {
  destination: string;
  outcome: CallerOutcomeKind;
}

export interface ChangePoint {
  /** Position (0-indexed) in the abstract L/S token order this fires at. */
  stepIndex: number;
  /** Caller whose priority is demoted when this change point fires. */
  caller: number;
}

/**
 * A schedule is a compact, shrinkable *specification*; the concrete
 * sequence of scheduling actions is re-derived deterministically from it
 * (see `planSchedule`/`abstractOrder` below) every time it is executed, so
 * re-running the same spec always reproduces the same run.
 */
export interface ScheduleSpec {
  seed: number;
  callers: CallerSpec[];
  changePoints: ChangePoint[];
  /** Probability [0,1] of inserting a microtask-drain between two adjacent abstract steps. */
  drainProbability: number;
  /**
   * Number of sequential, fully-awaited infra-failing calls issued (against
   * a dedicated destination) before the randomized concurrent phase begins.
   * Without this, every caller in the concurrent phase launches while the
   * breaker is still CLOSED (nothing has failed *and settled* yet to trip
   * it), so the HALF_OPEN race this fuzzer targets would almost never
   * actually occur. This is a deliberate bias toward the interesting region
   * of the schedule space, not a departure from randomized testing — only
   * the *concurrent* phase that follows is randomized/shrunk.
   */
  warmupFailures: number;
}

export type AbstractStep =
  { kind: 'launch'; caller: number } | { kind: 'settle'; caller: number } | { kind: 'drain' };

/**
 * PCT-style priority assignment + change-point demotion, adapted from
 * Burckhardt et al. (PCT, ASPLOS 2010) to this codebase's promise/microtask
 * concurrency: instead of "which of k OS threads runs next", the scheduling
 * decision here is "which of the ready abstract tokens (a caller's initial
 * `getScore` launch, or the settlement of that caller's own first
 * underlying call) runs next". See FUZZER_DESIGN.md section 2 for the
 * full justification and the probability-of-detection argument this
 * mechanism is meant to support.
 *
 * Each caller gets one `launch` token and one `settle` token; `settle(i)`
 * only becomes ready after `launch(i)` has been scheduled (a caller cannot
 * settle before it exists). Every caller starts with an independent random
 * priority; each change point, once its step index is reached, demotes one
 * caller's priority below everyone else's, biasing the *rest* of the
 * schedule toward interleavings that keep that caller "preempted" — the
 * direct analogue of PCT's priority-change points.
 */
export function abstractOrder(rng: Rng, k: number, changePoints: ChangePoint[]): AbstractStep[] {
  const priority = Array.from({ length: k }, () => rng());
  const launched = new Array<boolean>(k).fill(false);
  const settled = new Array<boolean>(k).fill(false);
  const order: AbstractStep[] = [];
  const totalSteps = 2 * k;

  const changePointsByStep = new Map<number, number[]>();
  for (const cp of changePoints) {
    if (cp.stepIndex < 0 || cp.stepIndex >= totalSteps || cp.caller < 0 || cp.caller >= k) continue;
    const arr = changePointsByStep.get(cp.stepIndex) ?? [];
    arr.push(cp.caller);
    changePointsByStep.set(cp.stepIndex, arr);
  }

  for (let step = 0; step < totalSteps; step++) {
    for (const target of changePointsByStep.get(step) ?? []) {
      priority[target] = Number.POSITIVE_INFINITY;
    }

    const ready: { caller: number; kind: 'launch' | 'settle'; tiebreak: number }[] = [];
    for (let i = 0; i < k; i++) {
      if (!launched[i]) ready.push({ caller: i, kind: 'launch', tiebreak: rng() });
      else if (!settled[i]) ready.push({ caller: i, kind: 'settle', tiebreak: rng() });
    }

    ready.sort((a, b) => priority[a.caller] - priority[b.caller] || a.tiebreak - b.tiebreak);
    const chosen = ready[0];
    order.push({ kind: chosen.kind, caller: chosen.caller });
    if (chosen.kind === 'launch') launched[chosen.caller] = true;
    else settled[chosen.caller] = true;
  }

  return order;
}

/**
 * Expands a `ScheduleSpec` into the concrete step sequence a harness will
 * execute, deterministically (same spec -> same steps, always).
 */
export function planSchedule(spec: ScheduleSpec): AbstractStep[] {
  const rng = mulberry32(spec.seed);
  const core = abstractOrder(rng, spec.callers.length, spec.changePoints);

  const withDrains: AbstractStep[] = [];
  for (const step of core) {
    if (withDrains.length > 0 && rng() < spec.drainProbability) {
      withDrains.push({ kind: 'drain' });
    }
    withDrains.push(step);
  }
  withDrains.push({ kind: 'drain' });
  return withDrains;
}

export interface GenerateOptions {
  rng: Rng;
  minCallers: number;
  maxCallers: number;
  destinations: readonly string[];
  depth: number;
  drainProbability: number;
  outcomeWeights?: Partial<Record<CallerOutcomeKind, number>>;
  warmupFailures?: number;
}

function weightedOutcome(rng: Rng, weights: Record<CallerOutcomeKind, number>): CallerOutcomeKind {
  const entries = Object.entries(weights) as [CallerOutcomeKind, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [kind, w] of entries) {
    if (x < w) return kind;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

/** Generates a random `ScheduleSpec` targeting a given PCT "depth". */
export function generateScheduleSpec(opts: GenerateOptions): ScheduleSpec {
  const { rng } = opts;
  const k = opts.minCallers + rngInt(rng, opts.maxCallers - opts.minCallers + 1);
  const weights: Record<CallerOutcomeKind, number> = {
    success: opts.outcomeWeights?.success ?? 1,
    'infra-fail': opts.outcomeWeights?.['infra-fail'] ?? 1,
    'logic-fail': opts.outcomeWeights?.['logic-fail'] ?? 0.3,
  };

  const callers: CallerSpec[] = Array.from({ length: k }, () => ({
    destination: opts.destinations[rngInt(rng, opts.destinations.length)],
    outcome: weightedOutcome(rng, weights),
  }));

  const totalSteps = 2 * k;
  const changePoints: ChangePoint[] = Array.from({ length: opts.depth }, () => ({
    stepIndex: rngInt(rng, totalSteps),
    caller: rngInt(rng, k),
  }));

  return {
    seed: rngInt(rng, 0xffffffff),
    callers,
    changePoints,
    drainProbability: opts.drainProbability,
    warmupFailures: opts.warmupFailures ?? 0,
  };
}
