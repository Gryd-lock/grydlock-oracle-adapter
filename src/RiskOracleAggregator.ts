import { DetailedRiskOracle, RiskOracle, ScoredResult } from './RiskOracle';
import { QuorumNotMetError } from './OracleError';
import { withTimeout } from './middleware/withTimeout';

/**
 * One source configured on a {@link RiskOracleAggregator}.
 */
export interface RiskOracleAggregatorSource {
  /**
   * Identifies this source in reputation tracking and in
   * {@link QuorumNotMetError} failure reports. Must be unique within a
   * single aggregator instance.
   */
  readonly label: string;
  /** The underlying score source. */
  readonly oracle: RiskOracle;
}

/**
 * Construction options for {@link RiskOracleAggregator}.
 */
export interface RiskOracleAggregatorOptions {
  /**
   * Sources queried concurrently on every call. Must satisfy
   * `sources.length >= 2 * faultTolerance + 1` — the standard Byzantine
   * fault tolerance bound, without which no aggregation rule (median,
   * trimmed mean, or otherwise) can guarantee an honest-range bound.
   */
  sources: readonly RiskOracleAggregatorSource[];
  /**
   * Maximum number of sources assumed to be Byzantine/faulty (arbitrary,
   * possibly coordinated, wrong answers) on any single call.
   */
  faultTolerance: number;
  /**
   * Minimum number of successful responses required before the aggregate is
   * produced. Must be in `[2 * faultTolerance + 1, sources.length]` — a
   * lower value cannot guarantee the honest-range bound (see the module
   * doc), and a value above `sources.length` can never be reached. Defaults
   * to the smallest safe value, `2 * faultTolerance + 1`, which maximizes
   * how many additional sources may be slow or failed (beyond the
   * `faultTolerance` budget already spent on Byzantine behavior) without
   * blocking the result.
   */
  quorum?: number;
  /**
   * Per-source timeout in milliseconds, enforced via {@link withTimeout}
   * around every individual source call. Bounds worst-case latency: a
   * hung source can never delay the result past this budget.
   */
  timeoutMs: number;
  /**
   * Smoothing factor in `(0, 1]` for the reputation exponential moving
   * average. Higher values weight recent calls more heavily. Defaults to
   * `0.3`.
   */
  reputationAlpha?: number;
  /**
   * Floor, in `(0, 1]`, on the reputation-derived weight multiplier a
   * source can be discounted to. A source is never fully zeroed out by
   * reputation alone (see the module doc for why the hard honest-range
   * bound does not depend on this). Defaults to `0.1`.
   */
  minWeight?: number;
  /**
   * Scale constant for the confidence formula `1 / (1 + dispersion /
   * confidenceScale)`. Smaller values make confidence fall off more
   * sharply as sources disagree. Defaults to `25`.
   */
  confidenceScale?: number;
  /** Clock returning epoch milliseconds. Injectable for tests. */
  now?: () => number;
}

interface SuccessOutcome {
  readonly label: string;
  readonly outcome: 'success';
  readonly value: number;
}

interface FailureOutcome {
  readonly label: string;
  readonly outcome: 'failure';
  readonly error: unknown;
}

type SourceOutcome = SuccessOutcome | FailureOutcome;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Weighted median of `values`, using the standard "lower weighted median"
 * definition: the smallest value at which the cumulative weight (in
 * ascending value order) first reaches half the total weight.
 *
 * With equal weights this is the ordinary median. Unlike a weighted mean, a
 * single extreme value cannot drag a weighted median arbitrarily far — its
 * breakdown point is a share of total *weight*, not of value magnitude,
 * which is what makes it a suitable base estimator to combine with the
 * order-statistic clamp in {@link honestOrderBounds} (see the module doc).
 *
 * @param values Reported scores, one per responding source.
 * @param weights Parallel array of positive weights, one per value.
 */
export function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('weightedMedian: values must be non-empty.');
  }
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cumulative = 0;
  for (const i of order) {
    cumulative += weights[i];
    if (cumulative >= total / 2) {
      return values[i];
    }
  }
  return values[order[order.length - 1]];
}

/**
 * The interval that any Byzantine-robust aggregate must be clamped into to
 * guarantee it falls within the honest sources' `[min, max]` range.
 *
 * Given `m` responses of which at most `faultTolerance` are Byzantine, the
 * `(faultTolerance + 1)`-th smallest value is provably `>= min(honest)`:
 * if it were smaller, all `faultTolerance + 1` of the smallest values would
 * have to be dishonest (an honest value can't be smaller than the honest
 * minimum), which exceeds the Byzantine budget. The symmetric argument
 * bounds the `(faultTolerance + 1)`-th largest value `<= max(honest)`. Both
 * bounds hold regardless of *which* responses are honest — the caller never
 * needs to know.
 *
 * This is the only part of {@link RiskOracleAggregator} that the hard
 * honest-range guarantee depends on; notably it does not depend on
 * reputation weights, so a Byzantine source cannot escape the bound by
 * first building up trust.
 *
 * @param values Reported scores, one per responding source (`values.length`
 * must be `>= 2 * faultTolerance + 1` for the bounds to be meaningful).
 * @param faultTolerance Maximum number of Byzantine values assumed among `values`.
 */
export function honestOrderBounds(
  values: readonly number[],
  faultTolerance: number,
): { lo: number; hi: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const loIndex = Math.min(faultTolerance, sorted.length - 1);
  const hiIndex = Math.max(sorted.length - 1 - faultTolerance, 0);
  return { lo: sorted[loIndex], hi: sorted[hiIndex] };
}

/**
 * A dilution-resistant disagreement measure for {@link RiskOracleAggregator}'s
 * confidence calibration.
 *
 * The naive choice — the mean (or median) absolute deviation of all
 * responses from `center` — can be gamed: a Byzantine coalition that
 * reports values equal to `center` adds zero-deviation terms that lower the
 * *average*, manufacturing apparent agreement even when the honest sources
 * genuinely disagree (verified against exactly this attack in
 * RiskOracleAggregator.adversarial.test.ts).
 *
 * This measure defeats that by dropping the `faultTolerance` values
 * *closest* to `center` before averaging the rest. Since a coalition of at
 * most `faultTolerance` values can occupy at most all of the dropped slots,
 * the worst case for an attacker is exactly parity with the honest-only
 * average (dropping only their own manufactured near-zero terms) — they can
 * never push the surviving average, and therefore the confidence derived
 * from it, below the honest sources' own natural disagreement. Any
 * coalition strategy that fails to fully occupy the dropped slots leaves at
 * least one adversarial value in the kept (larger-distance) set, which can
 * only raise the average further. This is verified empirically by the
 * adversarial coalition search in RiskOracleAggregator.adversarial.test.ts.
 *
 * @param values Reported scores, one per responding source.
 * @param center The point disagreement is measured against (the final aggregate).
 * @param faultTolerance Maximum number of Byzantine values assumed among `values`.
 */
export function computeDisagreement(
  values: readonly number[],
  center: number,
  faultTolerance: number,
): number {
  const distances = values.map((v) => Math.abs(v - center)).sort((a, b) => a - b);
  const kept = distances.slice(faultTolerance);
  if (kept.length === 0) {
    return 0;
  }
  return kept.reduce((sum, d) => sum + d, 0) / kept.length;
}

/**
 * Byzantine-fault-tolerant `DetailedRiskOracle` that fuses `n` independently
 * configured sources into one score plus a calibrated confidence.
 *
 * ## Algorithm
 *
 * 1. Query every configured source concurrently, each individually bounded
 *    by {@link withTimeout}. Resolve as soon as `quorum` have answered
 *    successfully (or reject with {@link QuorumNotMetError} the moment
 *    reaching quorum becomes impossible) — a hung source never blocks the
 *    result past its own timeout budget once quorum is otherwise reachable.
 * 2. Compute a reputation-weighted median of the successful reports (see
 *    {@link weightedMedian}) as the preferred estimate.
 * 3. Clamp that estimate into {@link honestOrderBounds}. This step alone
 *    is what guarantees the returned score falls within the honest
 *    sources' `[min, max]` range for any `<= faultTolerance` Byzantine
 *    sources, given `sources.length >= 2 * faultTolerance + 1` — and it
 *    holds regardless of the weights used in step 2, so reputation can
 *    never be leveraged to break it.
 * 4. Calibrate confidence from {@link computeDisagreement} of the raw
 *    reports around the final aggregate: `1 / (1 + dispersion /
 *    confidenceScale)`, in `(0, 1]`, strictly decreasing in dispersion and
 *    capped at `1` only when every source (after discounting the
 *    `faultTolerance` closest to the aggregate) agrees exactly.
 * 5. Update each responding source's reputation: an exponential moving
 *    average of `1 - |report - aggregate| / 100` for a successful
 *    response, or `0` for a response that failed/timed out in time to be
 *    counted this call. A source's reputation is never touched by a call
 *    it did not settle for in time.
 *
 * ## Statefulness
 *
 * Reputation is kept in-memory, in a `Map` keyed by source label, for the
 * lifetime of the `RiskOracleAggregator` instance. It is lazily initialized
 * to full trust (`1`) the first time a source responds, is updated after
 * every call per the rule above, and is never persisted — a process
 * restart resets every source to full trust. Use
 * {@link RiskOracleAggregator.getReputationSnapshot} to inspect or persist
 * it externally if needed.
 *
 * ## Failure
 *
 * If fewer than `quorum` sources answer successfully — including the
 * zero-successful-sources case — `getScore`/`getScoreDetailed` reject with
 * {@link QuorumNotMetError}.
 */
export class RiskOracleAggregator implements DetailedRiskOracle {
  private readonly sources: readonly RiskOracleAggregatorSource[];
  private readonly faultTolerance: number;
  private readonly quorum: number;
  private readonly timeoutMs: number;
  private readonly reputationAlpha: number;
  private readonly minWeight: number;
  private readonly confidenceScale: number;
  private readonly now: () => number;
  private readonly reputation = new Map<string, number>();

  constructor(options: RiskOracleAggregatorOptions) {
    const {
      sources,
      faultTolerance,
      quorum,
      timeoutMs,
      reputationAlpha = 0.3,
      minWeight = 0.1,
      confidenceScale = 25,
      now = Date.now,
    } = options;

    if (!Number.isInteger(faultTolerance) || faultTolerance < 0) {
      throw new Error(
        `RiskOracleAggregator: faultTolerance must be a non-negative integer, got ${faultTolerance}.`,
      );
    }

    const n = sources.length;
    const minSafeQuorum = 2 * faultTolerance + 1;
    if (n < minSafeQuorum) {
      throw new Error(
        `RiskOracleAggregator: ${n} source(s) configured but faultTolerance=${faultTolerance} ` +
          `requires at least ${minSafeQuorum} (n >= 2*faultTolerance+1) to guarantee the honest-range bound.`,
      );
    }

    const labels = new Set<string>();
    for (const source of sources) {
      if (labels.has(source.label)) {
        throw new Error(
          `RiskOracleAggregator: duplicate source label "${source.label}" — labels must be ` +
            `unique; they are used as the reputation key.`,
        );
      }
      labels.add(source.label);
    }

    const resolvedQuorum = quorum ?? minSafeQuorum;
    if (resolvedQuorum < minSafeQuorum || resolvedQuorum > n) {
      throw new Error(
        `RiskOracleAggregator: quorum must be between ${minSafeQuorum} (2*faultTolerance+1) ` +
          `and ${n} (total sources); got ${resolvedQuorum}.`,
      );
    }

    if (!(timeoutMs > 0)) {
      throw new Error(`RiskOracleAggregator: timeoutMs must be > 0, got ${timeoutMs}.`);
    }
    if (!(reputationAlpha > 0 && reputationAlpha <= 1)) {
      throw new Error(
        `RiskOracleAggregator: reputationAlpha must be in (0, 1], got ${reputationAlpha}.`,
      );
    }
    if (!(minWeight > 0 && minWeight <= 1)) {
      throw new Error(`RiskOracleAggregator: minWeight must be in (0, 1], got ${minWeight}.`);
    }

    this.sources = sources;
    this.faultTolerance = faultTolerance;
    this.quorum = resolvedQuorum;
    this.timeoutMs = timeoutMs;
    this.reputationAlpha = reputationAlpha;
    this.minWeight = minWeight;
    this.confidenceScale = confidenceScale;
    this.now = now;
  }

  /** @returns The aggregate's `score`, same value {@link getScoreDetailed} would resolve. */
  async getScore(destination: string): Promise<number> {
    const result = await this.getScoreDetailed(destination);
    return result.score;
  }

  /**
   * Resolves the fused score and its calibrated confidence for `destination`.
   *
   * @throws {QuorumNotMetError} If fewer than the configured quorum of
   * sources answer successfully (including zero successes).
   */
  async getScoreDetailed(destination: string): Promise<ScoredResult> {
    const outcomes = await this.collectQuorum(destination);
    const successes = outcomes.filter((o): o is SuccessOutcome => o.outcome === 'success');

    const values = successes.map((s) => s.value);
    const weights = successes.map((s) => this.weightFor(s.label));

    const rawEstimate = weightedMedian(values, weights);
    const { lo, hi } = honestOrderBounds(values, this.faultTolerance);
    const aggregate = clamp(rawEstimate, lo, hi);
    const score = Math.round(clamp(aggregate, 0, 100));

    const dispersion = computeDisagreement(values, aggregate, this.faultTolerance);
    const confidence = 1 / (1 + dispersion / this.confidenceScale);

    this.updateReputation(outcomes, aggregate);

    return {
      score,
      timestamp: this.now(),
      source: 'RiskOracleAggregator',
      cacheStatus: 'live',
      confidence,
    };
  }

  /**
   * Current reputation-derived weight multiplier (in `[minWeight, 1]`) for
   * every configured source, keyed by label. Sources with no call history
   * yet report `1` (full trust). Exposed for observability and testing —
   * see the class doc's "Statefulness" section.
   */
  getReputationSnapshot(): ReadonlyMap<string, number> {
    const snapshot = new Map<string, number>();
    for (const source of this.sources) {
      snapshot.set(source.label, this.weightFor(source.label));
    }
    return snapshot;
  }

  private weightFor(label: string): number {
    const ema = this.reputation.get(label) ?? 1;
    return this.minWeight + (1 - this.minWeight) * ema;
  }

  private updateReputation(outcomes: readonly SourceOutcome[], aggregate: number): void {
    for (const outcome of outcomes) {
      const agreement =
        outcome.outcome === 'success'
          ? 1 - clamp(Math.abs(outcome.value - aggregate), 0, 100) / 100
          : 0;
      const prev = this.reputation.get(outcome.label) ?? 1;
      const next = this.reputationAlpha * agreement + (1 - this.reputationAlpha) * prev;
      this.reputation.set(outcome.label, next);
    }
  }

  /**
   * Queries every source concurrently and resolves with the outcomes known
   * at the moment quorum is reached, without waiting for slower/hung
   * sources that are no longer needed. Rejects with
   * {@link QuorumNotMetError} the instant reaching quorum becomes
   * mathematically impossible (successes so far plus still-pending sources
   * fewer than required), rather than waiting for every source to settle.
   */
  private collectQuorum(destination: string): Promise<SourceOutcome[]> {
    const { sources, quorum, timeoutMs } = this;
    const n = sources.length;

    return new Promise<SourceOutcome[]>((resolve, reject) => {
      const settled: SourceOutcome[] = [];
      let successCount = 0;
      let doneCount = 0;
      let decided = false;

      const maybeDecide = (): void => {
        if (decided) return;

        if (successCount >= quorum) {
          decided = true;
          resolve(settled.slice());
          return;
        }

        const stillPending = n - doneCount;
        if (successCount + stillPending < quorum) {
          decided = true;
          const failures: Record<string, string> = {};
          for (const outcome of settled) {
            if (outcome.outcome === 'failure') {
              failures[outcome.label] =
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            }
          }
          reject(
            new QuorumNotMetError(destination, {
              required: quorum,
              succeeded: successCount,
              total: n,
              failures,
            }),
          );
        }
      };

      for (const source of sources) {
        const bounded = withTimeout({ timeoutMs })(source.oracle);
        bounded.getScore(destination).then(
          (value) => {
            if (!Number.isFinite(value)) {
              settled.push({
                label: source.label,
                outcome: 'failure',
                error: new Error(`"${source.label}" returned a non-finite score: ${value}`),
              });
              doneCount += 1;
              maybeDecide();
              return;
            }
            settled.push({ label: source.label, outcome: 'success', value });
            successCount += 1;
            doneCount += 1;
            maybeDecide();
          },
          (error: unknown) => {
            settled.push({ label: source.label, outcome: 'failure', error });
            doneCount += 1;
            maybeDecide();
          },
        );
      }
    });
  }
}
