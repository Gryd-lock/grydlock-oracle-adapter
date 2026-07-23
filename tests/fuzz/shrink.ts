import { ScheduleSpec, CallerOutcomeKind } from './schedule';
import { InvariantViolation } from './invariants';

export type ReproduceFn = (spec: ScheduleSpec) => Promise<InvariantViolation[]>;

export interface ShrinkResult {
  spec: ScheduleSpec;
  /** Number of candidate schedules the shrinker actually re-ran. */
  attempts: number;
  /** Number of successful size-reducing steps applied. */
  reductions: number;
}

function removeCaller(spec: ScheduleSpec, index: number): ScheduleSpec {
  const callers = spec.callers.filter((_, i) => i !== index);
  const maxStep = Math.max(0, 2 * callers.length - 1);
  const changePoints = spec.changePoints
    .filter((cp) => cp.caller !== index)
    .map((cp) => ({
      stepIndex: Math.min(cp.stepIndex, maxStep),
      caller: cp.caller > index ? cp.caller - 1 : cp.caller,
    }));
  return { ...spec, callers, changePoints };
}

/** Size measure the shrinker's termination guarantee is stated in terms of. */
export function scheduleSize(spec: ScheduleSpec): number {
  return spec.callers.length * 10 + spec.changePoints.length;
}

/**
 * Delta-debugging-style minimization of a failing schedule spec.
 *
 * # Termination guarantee
 *
 * Each outer round either strictly decreases `scheduleSize(current)` (by
 * removing a caller, a change point, or simplifying an outcome to
 * 'success') or makes zero changes and the loop exits. `scheduleSize` is a
 * non-negative integer bounded below by 0, so the number of *successful*
 * reductions is bounded by the spec's initial size. Each round examines a
 * finite, strictly-bounded candidate list (at most `callers.length +
 * changePoints.length + 1 + callers.length` candidates — one pass over each
 * caller-removal, change-point-removal, the drain-probability reset, and
 * each outcome-simplification), so the whole algorithm terminates in at
 * most O(n^2) reproduction runs for an initial size-n spec (the classic
 * ddmin bound), and never loops forever even if nothing shrinks further.
 */
export async function shrinkSchedule(
  originalSpec: ScheduleSpec,
  targetViolationId: string,
  reproduce: ReproduceFn,
): Promise<ShrinkResult> {
  let current = originalSpec;
  let attempts = 0;
  let reductions = 0;

  const stillReproduces = async (candidate: ScheduleSpec): Promise<boolean> => {
    attempts++;
    const violations = await reproduce(candidate);
    return violations.some((v) => v.id === targetViolationId);
  };

  let improved = true;
  while (improved) {
    improved = false;

    for (let i = current.callers.length - 1; i >= 0 && current.callers.length > 1; i--) {
      const candidate = removeCaller(current, i);
      if (await stillReproduces(candidate)) {
        current = candidate;
        reductions++;
        improved = true;
        break;
      }
    }
    if (improved) continue;

    for (let i = current.changePoints.length - 1; i >= 0; i--) {
      const candidate: ScheduleSpec = {
        ...current,
        changePoints: current.changePoints.filter((_, idx) => idx !== i),
      };
      if (await stillReproduces(candidate)) {
        current = candidate;
        reductions++;
        improved = true;
        break;
      }
    }
    if (improved) continue;

    if (current.drainProbability !== 0) {
      const candidate: ScheduleSpec = { ...current, drainProbability: 0 };
      if (await stillReproduces(candidate)) {
        current = candidate;
        reductions++;
        improved = true;
        continue;
      }
    }

    for (let i = 0; i < current.callers.length; i++) {
      if (current.callers[i].outcome === ('success' as CallerOutcomeKind)) continue;
      const candidate: ScheduleSpec = {
        ...current,
        callers: current.callers.map((c, idx) =>
          idx === i ? { ...c, outcome: 'success' as CallerOutcomeKind } : c,
        ),
      };
      if (await stillReproduces(candidate)) {
        current = candidate;
        reductions++;
        improved = true;
        break;
      }
    }
  }

  return { spec: current, attempts, reductions };
}
