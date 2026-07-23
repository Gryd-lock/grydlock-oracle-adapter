import { CircuitBreakerState } from './CircuitBreakerOracle';
import { CacheStatus, DetailedRiskOracle, RiskOracle, ScoredResult } from './RiskOracle';
import { FallbackObserver } from './FallbackObserver';

/**
 * Discounted-UCB belief for a single tier: a discounted pull count and a
 * discounted success count. Both are decayed by `discountFactor` every
 * routing round (not just on the tier's own pulls), so old evidence loses
 * influence at a fixed, continuous rate regardless of how often a tier is
 * actually tried.
 */
interface TierBelief {
  discountedPulls: number;
  discountedSuccesses: number;
}

/** One tier's rank and belief snapshot for a single `getScore`/`getScoreDetailed` call. */
export interface TierRoutingDecision {
  /** Index of this tier in the chain passed to the constructor. */
  tierIndex: number;
  /** Human-readable tier label, also used as `ScoredResult.source` when this tier answers. */
  label: string;
  /** The discounted-UCB index used to rank this tier for this call. */
  ucbScore: number;
  /** Discounted success rate entering this call (before this call's own observation, if any). */
  discountedSuccessRate: number;
  /** Discounted pull count entering this call. */
  discountedPulls: number;
  /** Whether this tier was actually called this round. */
  attempted: boolean;
  /** Result of the attempt, or 'not-reached' if an earlier-ranked tier already succeeded. */
  outcome: 'success' | 'failure' | 'not-reached';
  /**
   * Whether this attempt's outcome was fed into the bandit's belief. False when the tier
   * fast-failed behind an OPEN CircuitBreakerOracle — see the class doc for why.
   */
  learned: boolean;
}

/** `ScoredResult` enriched with the bandit's full routing decision for the call. */
export interface FallbackScoredResult extends ScoredResult {
  /** Every tier in the chain, ranked richest-first as chosen for this call. */
  routingOrder: TierRoutingDecision[];
  /** Index into the chain of the tier that actually answered. */
  answeredTierIndex: number;
}

/** Tunables for the routing bandit. See {@link FallbackOracle} for how to reason about them. */
export interface FallbackBanditConfig {
  /**
   * Exploration constant (`c` in the UCB1 bonus `sqrt(c * ln(n) / n_i)`). Higher values make
   * the bandit probe presumed-bad tiers more often, at the cost of more wasted latency spent on
   * tiers likely still down; lower values exploit the currently-best tier more aggressively, at
   * the cost of noticing a recovered tier more slowly. Default 2, the canonical UCB1 constant.
   */
  explorationFactor?: number;
  /**
   * Per-round decay applied to every tier's belief (0, 1). Controls the bandit's memory: its
   * effective horizon is roughly `1 / (1 - discountFactor)` calls. Closer to 1 means longer
   * memory and more stable estimates under noise but slower adaptation to real drift; closer to
   * 0 means near-immediate adaptation but noisy, thrash-prone estimates. Default 0.98 (~50-call
   * horizon).
   */
  discountFactor?: number;
  /** Optional human-readable labels for each tier, by chain index. Defaults to `Ctor[index]`. */
  tierNames?: readonly string[];
}

const DEFAULT_EXPLORATION_FACTOR = 2;
const DEFAULT_DISCOUNT_FACTOR = 0.98;
/**
 * Rank value assigned to a tier whose discounted pull count has decayed to ~0 (never tried, or
 * not tried in so long its evidence is gone). Large-but-finite, not Infinity, so ties between
 * multiple unexplored tiers subtract cleanly to 0 in the sort comparator and fall back to
 * original chain order (stable sort) instead of `Infinity - Infinity === NaN`.
 */
const UNEXPLORED_PRIORITY = 1e9;
const MIN_DISCOUNTED_PULLS = 1e-9;

function hasCircuitBreakerState(
  oracle: RiskOracle,
): oracle is RiskOracle & { getState(): CircuitBreakerState } {
  return typeof (oracle as Partial<{ getState(): CircuitBreakerState }>).getState === 'function';
}

function isDetailed(oracle: RiskOracle): oracle is DetailedRiskOracle {
  return typeof (oracle as Partial<DetailedRiskOracle>).getScoreDetailed === 'function';
}

/**
 * Tries multiple oracles in priority order until one succeeds, choosing that order fresh on
 * every call with a non-stationary multi-armed bandit over each tier's recent success rate.
 *
 * ## Why a bandit, and why discounting
 *
 * A fixed cooldown after N failures implicitly assumes tier health is binary and slow-changing.
 * Real tier failure rates drift continuously, so this class treats each tier as a bandit arm and
 * runs discounted UCB (Garivier & Moulines, "On Upper-Confidence Bound Policies for Non-Stationary
 * Bandit Problems"): every call, every tier's belief decays by `discountFactor`, then the tier
 * actually pulled gets its observation added. This was chosen over the two other standard
 * non-stationarity mechanisms:
 *
 * - **Sliding-window UCB** (only the last W observations count) needs W chosen to roughly match
 *   the drift speed: too small and estimates are noisy, too large and it reacts too slowly to a
 *   real step change. Discounting has no such per-drift-speed knob — the same `discountFactor`
 *   adapts to both abrupt and gradual drift because it downweights continuously rather than
 *   truncating at a hard boundary.
 * - **Change-point detection** (e.g. CUSUM) requires a detection threshold that trades false
 *   positives (thrashing on noise) against false negatives (missing a real shift), and a full
 *   belief reset on trigger throws away potentially-still-useful history about *other* tiers.
 *   Discounting degrades gracefully instead of resetting.
 * - Discounting is also O(1) memory per tier (two running numbers), vs. O(W) for a window.
 *
 * ## Reconciling with CircuitBreakerOracle
 *
 * `CircuitBreakerOracle` is treated as a correct black box: this class never inspects or
 * replicates its threshold/cooldown state machine. It only reads the *public* `getState()` a
 * chain member may expose. When a tier's state is `OPEN` at the moment it's tried, the call still
 * happens (so the breaker's own HALF_OPEN probing continues to work untouched) — but the
 * bandit's belief is **not** updated from that call's outcome. An OPEN breaker fast-fails from
 * state it already holds; feeding that into the bandit would be re-observing the same verdict
 * the breaker recorded when it first tripped, not new evidence, and would pin the tier's
 * discounted failure rate near 100% long after it may have actually recovered (a real HALF_OPEN
 * probe only updates the bandit once the breaker itself has moved off OPEN). A tier that is
 * CLOSED or HALF_OPEN when tried is a genuine attempt, and its outcome is learned normally.
 *
 * ## Routing order, not skip/don't-skip
 *
 * Every call ranks *all* tiers by their current UCB index and tries them in that full order —
 * there is no separate skip decision. A tier that looks dead still gets a `UNEXPLORED_PRIORITY`-
 * or bonus-driven turn once its exploration term grows large enough, which is what guarantees
 * eventual recovery detection without a hand-rolled retry timer.
 */
export class FallbackOracle implements DetailedRiskOracle {
  private readonly beliefs: TierBelief[];
  private readonly labels: string[];
  private readonly explorationFactor: number;
  private readonly discountFactor: number;

  constructor(
    private readonly chain: readonly RiskOracle[],
    private readonly observer?: FallbackObserver,
    config: FallbackBanditConfig = {},
  ) {
    this.explorationFactor = config.explorationFactor ?? DEFAULT_EXPLORATION_FACTOR;
    this.discountFactor = config.discountFactor ?? DEFAULT_DISCOUNT_FACTOR;
    this.beliefs = chain.map(() => ({ discountedPulls: 0, discountedSuccesses: 0 }));
    this.labels = chain.map(
      (oracle, index) => config.tierNames?.[index] ?? `${oracle.constructor.name}[${index}]`,
    );
  }

  async getScore(destination: string): Promise<number> {
    const result = await this.route(destination);
    return result.score;
  }

  /**
   * @returns The same score `getScore` would resolve, with `source` set to the tier that
   * actually answered and `routingOrder` carrying the full bandit ranking used for this call.
   */
  async getScoreDetailed(destination: string): Promise<FallbackScoredResult> {
    return this.route(destination);
  }

  /** Decays every tier's belief one round, then ranks tiers richest-first by UCB index. */
  private rankTiers(): TierRoutingDecision[] {
    for (const belief of this.beliefs) {
      belief.discountedPulls *= this.discountFactor;
      belief.discountedSuccesses *= this.discountFactor;
    }

    const totalDiscountedPulls = this.beliefs.reduce((sum, b) => sum + b.discountedPulls, 0);

    const decisions: TierRoutingDecision[] = this.beliefs.map((belief, tierIndex) => ({
      tierIndex,
      label: this.labels[tierIndex],
      ucbScore: this.ucbScore(belief, totalDiscountedPulls),
      discountedSuccessRate:
        belief.discountedPulls < MIN_DISCOUNTED_PULLS
          ? 0
          : belief.discountedSuccesses / belief.discountedPulls,
      discountedPulls: belief.discountedPulls,
      attempted: false,
      outcome: 'not-reached',
      learned: false,
    }));

    decisions.sort((a, b) => b.ucbScore - a.ucbScore);
    return decisions;
  }

  private ucbScore(belief: TierBelief, totalDiscountedPulls: number): number {
    if (belief.discountedPulls < MIN_DISCOUNTED_PULLS) {
      return UNEXPLORED_PRIORITY;
    }
    const mean = belief.discountedSuccesses / belief.discountedPulls;
    const bonus = Math.sqrt(
      (this.explorationFactor * Math.log(Math.max(totalDiscountedPulls, Math.E))) /
        belief.discountedPulls,
    );
    return mean + bonus;
  }

  private async route(destination: string): Promise<FallbackScoredResult> {
    if (this.chain.length === 0) {
      throw new Error('FallbackOracle has no configured oracles.');
    }

    const decisions = this.rankTiers();
    let lastError: unknown;

    for (const decision of decisions) {
      const oracle = this.chain[decision.tierIndex];
      const belief = this.beliefs[decision.tierIndex];
      const stateBefore = hasCircuitBreakerState(oracle) ? oracle.getState() : undefined;
      const learnsFromThisAttempt = stateBefore !== CircuitBreakerState.OPEN;
      decision.attempted = true;

      try {
        let score: number;
        let cacheStatus: CacheStatus = 'live';
        if (isDetailed(oracle)) {
          const detailed = await oracle.getScoreDetailed(destination);
          score = detailed.score;
          cacheStatus = detailed.cacheStatus;
        } else {
          score = await oracle.getScore(destination);
        }

        decision.outcome = 'success';
        decision.learned = learnsFromThisAttempt;
        if (learnsFromThisAttempt) {
          belief.discountedPulls += 1;
          belief.discountedSuccesses += 1;
        }

        return {
          score,
          timestamp: Date.now(),
          source: decision.label,
          cacheStatus,
          confidence:
            belief.discountedPulls < MIN_DISCOUNTED_PULLS
              ? undefined
              : belief.discountedSuccesses / belief.discountedPulls,
          routingOrder: decisions,
          answeredTierIndex: decision.tierIndex,
        };
      } catch (error) {
        lastError = error;
        this.observer?.onFallback(error, oracle);

        decision.outcome = 'failure';
        decision.learned = learnsFromThisAttempt;
        if (learnsFromThisAttempt) {
          belief.discountedPulls += 1;
        }
      }
    }

    if (lastError instanceof Error) {
      Object.assign(lastError, { routingOrder: decisions } satisfies Pick<
        FallbackScoredResult,
        'routingOrder'
      >);
    }
    throw lastError;
  }
}
