/**
 * A PCT-style randomized concurrency-schedule fuzzer, adapted from OS-thread
 * preemption scheduling (Burckhardt, Kothari, Musuvathi, Nagarakatte,
 * "A Randomized Scheduler with Probabilistic Guarantees of Finding Bugs",
 * ASPLOS 2010) to this codebase's promise/microtask concurrency model.
 *
 * ## What "scheduling point" means here
 *
 * There are no OS threads or preemption in this codebase's concurrency: every
 * "concurrent caller" is really just an async function whose only points of
 * suspension are `await`s on promises this test harness controls directly
 * (via `createDeferred`). The two things a real scheduler would control —
 * *which runnable thread executes next* and *when it gets preempted* — map
 * onto two things we control directly instead:
 *
 * 1. **Settlement order** — the order in which we call `.resolve()`/`.reject()`
 *    on each caller's controlled deferred. This is the direct analogue of
 *    "which thread runs next": settling a deferred is what lets that caller's
 *    `await` continuation (and therefore its subsequent synchronous state
 *    mutations) run next.
 * 2. **Microtask tick count** — how many bare `await Promise.resolve()` ticks
 *    we interleave between settlements. This fuzzes how many pending `.then`
 *    continuations from *other* callers get to drain before the next
 *    settlement, which is the analogue of a thread's preemption-window length.
 *
 * ## PCT's priority-perturbation mechanism, adapted
 *
 * PCT assigns each of the `k` threads a distinct random priority and inserts
 * `d - 1` random *priority-change points* among the `n` scheduling events;
 * at each one, the currently-running (would-be-highest-priority) thread is
 * demoted below every other runnable thread, forcing a *different* thread to
 * run next. This is what lets PCT reach deep, specific interleavings with
 * non-negligible probability instead of relying on uniform-random sampling
 * (which wastes almost all its probability mass on shallow, easily-taken
 * interleavings) — its formal guarantee is that a bug requiring exactly `d`
 * specific ordering decisions is found with probability at least
 * `1 / (n * k^(d-1))` per run (see `docs/concurrency-fuzzer.md` for the
 * iteration-budget derivation from this bound).
 *
 * This module reuses the identical mechanism at settlement granularity: each
 * caller (a "task") gets a random distinct priority; `changePoints` records
 * which settlement events are priority-change points; at those events, the
 * naturally-next task (the highest-priority one still pending) is demoted
 * below every other still-pending task, so a different, otherwise-lower-
 * priority task settles first instead. The random tick counts additionally
 * perturb *where in the microtask queue* that settlement's effects land
 * relative to other pending `.then` continuations — there is no equivalent
 * knob in the original OS-thread PCT, since OS schedulers don't have a
 * microtask queue, but it is the natural extra degree of freedom in this
 * concurrency model and costs nothing extra to randomize.
 *
 * Everything here is driven by a seeded PRNG (`mulberry32`), so a schedule is
 * fully determined by its seed and generation options: the same seed always
 * reproduces the exact same schedule, satisfying the "deterministic given a
 * fixed seed" requirement.
 */

export type Rng = () => number;

/** Small, fast, seeded PRNG. No dependency needed for deterministic fuzzing. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Awaits `n` bare microtask ticks (used to fuzz `.then`-continuation drain order). */
export async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/**
 * Distinguishable failure injected by the fuzzer, so invariant checks (and
 * the `unhandledRejection` listener in the Coalescing fuzz tests) can tell a
 * fuzzer-injected failure apart from anything unrelated happening to reject
 * during a test run.
 */
export class FuzzInjectedError extends Error {
  constructor(message = 'fuzz-injected-failure') {
    super(message);
    this.name = 'FuzzInjectedError';
  }
}

export interface CallerOutcome {
  kind: 'success' | 'failure';
  value: number;
  error: unknown;
}

/**
 * A fully-specified, replayable concurrency schedule for `numCallers`
 * concurrent callers. Every field is populated by the seeded generator so
 * replaying a `Schedule` is deterministic without needing the original seed.
 */
export interface Schedule {
  readonly seed: number;
  readonly numCallers: number;
  /** Per-caller outcome to apply when that caller's controlled promise settles. */
  readonly outcomes: CallerOutcome[];
  /** Per-caller PCT priority (higher settles first, absent a change point). */
  readonly priorities: number[];
  /** Settlement-event indices (0-based, within [0, numCallers)) that are priority-change points. */
  readonly changePoints: number[];
  /** Per-caller microtask ticks to await immediately before that caller settles. */
  readonly preSettleTicks: number[];
  /** Per-caller microtask ticks to await immediately after that caller settles. */
  readonly postSettleTicks: number[];
}

export interface ScheduleGenOptions {
  minCallers?: number;
  maxCallers?: number;
  /** Target bug depth `d`; generates `min(d - 1, numCallers - 1)` change points. */
  targetDepth?: number;
  maxTicks?: number;
  /** Overrides how per-caller outcomes are sampled (default: 50/50 success/failure). */
  outcomeSampler?: (rng: Rng, callerIndex: number) => CallerOutcome;
}

function defaultOutcomeSampler(rng: Rng): CallerOutcome {
  if (rng() < 0.5) {
    return { kind: 'success', value: Math.floor(rng() * 100), error: undefined };
  }
  return { kind: 'failure', value: 0, error: new FuzzInjectedError() };
}

/** Generates a fully-specified `Schedule` deterministically from `seed`. */
export function generateSchedule(seed: number, opts: ScheduleGenOptions = {}): Schedule {
  const rng = mulberry32(seed);
  const minCallers = opts.minCallers ?? 2;
  const maxCallers = opts.maxCallers ?? 5;
  const targetDepth = opts.targetDepth ?? 3;
  const maxTicks = opts.maxTicks ?? 2;
  const sampler = opts.outcomeSampler ?? defaultOutcomeSampler;

  const numCallers = randInt(rng, minCallers, maxCallers);
  const priorities = shuffle(
    rng,
    Array.from({ length: numCallers }, (_, i) => i),
  );

  const numChangePoints = Math.max(0, Math.min(targetDepth - 1, numCallers - 1));
  const changePoints = shuffle(
    rng,
    Array.from({ length: numCallers }, (_, i) => i),
  )
    .slice(0, numChangePoints)
    .sort((a, b) => a - b);

  const outcomes = Array.from({ length: numCallers }, (_, i) => sampler(rng, i));
  const preSettleTicks = Array.from({ length: numCallers }, () => randInt(rng, 0, maxTicks));
  const postSettleTicks = Array.from({ length: numCallers }, () => randInt(rng, 0, maxTicks));

  return { seed, numCallers, outcomes, priorities, changePoints, preSettleTicks, postSettleTicks };
}

/**
 * Executes `schedule` against a pool of controllable deferreds, settling
 * only the indices in `activeIndices` (defaults to all of them). Restricting
 * to `activeIndices` is what lets the same schedule drive both a correct,
 * single-probe implementation (where only one deferred is ever created) and
 * a buggy, thundering-herd implementation (where all of them are) without
 * generating two different schedule shapes.
 *
 * PCT priority-change-point semantics: at each settlement-event index in
 * `schedule.changePoints`, the task that would naturally settle next (the
 * highest-priority still-pending one) is demoted below every other pending
 * task first, forcing a different task to settle instead.
 */
export async function executeSchedule(
  schedule: Schedule,
  deferreds: ReadonlyArray<Deferred<number>>,
  activeIndices?: readonly number[],
): Promise<number[]> {
  const indices = activeIndices ?? deferreds.map((_, i) => i);
  const pending = new Set(indices);
  const priority = new Map(indices.map((i) => [i, schedule.priorities[i] ?? 0]));
  const order: number[] = [];
  let settleCount = 0;

  const pickNext = (): number => {
    let best = -1;
    let bestPriority = -Infinity;
    for (const i of pending) {
      const p = priority.get(i) ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = i;
      }
    }
    return best;
  };

  while (pending.size > 0) {
    let next = pickNext();

    if (schedule.changePoints.includes(settleCount) && pending.size > 1) {
      const minPending = Math.min(...[...pending].map((i) => priority.get(i) ?? 0));
      priority.set(next, minPending - 1);
      next = pickNext();
    }

    pending.delete(next);
    order.push(next);

    await tick(schedule.preSettleTicks[next] ?? 0);

    const outcome = schedule.outcomes[next];
    const deferred = deferreds[next];
    if (outcome.kind === 'success') {
      deferred.resolve(outcome.value);
    } else {
      deferred.reject(outcome.error);
    }

    await tick(schedule.postSettleTicks[next] ?? 0);
    settleCount++;
  }

  return order;
}

function sumTicks(ticks: readonly number[]): number {
  return ticks.reduce((a, b) => a + b, 0);
}

/** A coarse, strictly-decreasing complexity measure used as the shrinker's termination metric. */
export function scheduleSize(schedule: Schedule): number {
  return (
    schedule.numCallers * 1000 +
    schedule.changePoints.length * 10 +
    sumTicks(schedule.preSettleTicks) +
    sumTicks(schedule.postSettleTicks)
  );
}

function removeCaller(schedule: Schedule, dropIndex: number): Schedule {
  const drop = <T>(arr: readonly T[]): T[] => arr.filter((_, i) => i !== dropIndex);
  const numCallers = schedule.numCallers - 1;
  return {
    ...schedule,
    numCallers,
    outcomes: drop(schedule.outcomes),
    priorities: drop(schedule.priorities),
    preSettleTicks: drop(schedule.preSettleTicks),
    postSettleTicks: drop(schedule.postSettleTicks),
    changePoints: schedule.changePoints.filter((cp) => cp < numCallers),
  };
}

function removeChangePoint(schedule: Schedule, index: number): Schedule {
  return { ...schedule, changePoints: schedule.changePoints.filter((_, i) => i !== index) };
}

function zeroTicks(schedule: Schedule, callerIndex: number): Schedule {
  const preSettleTicks = schedule.preSettleTicks.slice();
  const postSettleTicks = schedule.postSettleTicks.slice();
  preSettleTicks[callerIndex] = 0;
  postSettleTicks[callerIndex] = 0;
  return { ...schedule, preSettleTicks, postSettleTicks };
}

export interface ShrinkResult {
  schedule: Schedule;
  originalSize: number;
  finalSize: number;
  /** Number of candidate schedules evaluated (bounded by `maxSteps`; see termination note below. */
  stepsTaken: number;
}

/**
 * Delta-debugging-style shrinker: given a `schedule` known to reproduce a
 * failure (per `reproduces`), repeatedly tries strictly simpler candidate
 * schedules (fewer callers, fewer change points, fewer microtask ticks) and
 * keeps any candidate that still reproduces the failure.
 *
 * ### Termination guarantee
 *
 * `scheduleSize` is a non-negative integer, and every accepted candidate
 * strictly decreases it (removing a caller: -1000 or more; removing a change
 * point: -10; zeroing a tick: -1 or more). A strictly-decreasing sequence of
 * non-negative integers is finite, so the outer improvement loop halts on
 * its own in at most `scheduleSize(schedule)` accepted steps. `maxSteps`
 * additionally bounds the total number of *candidates evaluated* (accepted
 * or not), giving a hard, schedule-independent ceiling on runtime.
 */
export async function shrinkSchedule(
  schedule: Schedule,
  reproduces: (candidate: Schedule) => boolean | Promise<boolean>,
  maxSteps = 2000,
): Promise<ShrinkResult> {
  let current = schedule;
  let steps = 0;
  const originalSize = scheduleSize(schedule);

  let improved = true;
  while (improved && steps < maxSteps) {
    improved = false;

    if (current.numCallers > 1) {
      for (let dropIndex = 0; dropIndex < current.numCallers && steps < maxSteps; dropIndex++) {
        steps++;
        const candidate = removeCaller(current, dropIndex);
        if (await reproduces(candidate)) {
          current = candidate;
          improved = true;
          break;
        }
      }
      if (improved) continue;
    }

    if (current.changePoints.length > 0) {
      for (let i = 0; i < current.changePoints.length && steps < maxSteps; i++) {
        steps++;
        const candidate = removeChangePoint(current, i);
        if (await reproduces(candidate)) {
          current = candidate;
          improved = true;
          break;
        }
      }
      if (improved) continue;
    }

    for (let i = 0; i < current.numCallers && steps < maxSteps; i++) {
      if (current.preSettleTicks[i] === 0 && current.postSettleTicks[i] === 0) continue;
      steps++;
      const candidate = zeroTicks(current, i);
      if (await reproduces(candidate)) {
        current = candidate;
        improved = true;
      }
    }
  }

  return { schedule: current, originalSize, finalSize: scheduleSize(current), stepsTaken: steps };
}
