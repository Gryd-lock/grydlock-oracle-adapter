import { RiskOracle } from './RiskOracle';
import { Logger, noopLogger } from './Logger';

/**
 * One destination to score as part of a batch call.
 */
export interface BatchDestinationRequest {
  /** A Stellar address or asset identifier. */
  destination: string;
  /**
   * Higher values are serviced first under contention. Default 0. Callers
   * should keep priorities within a small, consistent range (see
   * {@link BatchRiskOracleOptions.priorityNormalization}).
   */
  priority?: number;
}

/** Per-call options for a batch request. */
export interface BatchCallOptions {
  /**
   * Milliseconds from now by which the batch should ideally finish. Items
   * that cannot be started with at least `targetConfidence` estimated
   * probability of finishing before this deadline are rejected immediately
   * instead of being started and blowing the deadline anyway.
   */
  deadlineMs: number;
}

export type BatchItemStatus = 'fulfilled' | 'rejected' | 'deadline-rejected';

/** The individually-recoverable outcome of one destination in a batch. */
export interface BatchItemResult {
  destination: string;
  status: BatchItemStatus;
  /** Present when `status === 'fulfilled'`. */
  score?: number;
  /** Present when `status === 'rejected'`: the error the wrapped oracle threw. */
  error?: unknown;
}

export interface BatchResult {
  /** Same length and order as the input `requests`, one entry per request. */
  results: BatchItemResult[];
}

/**
 * Additive batch-scoring capability. Implementations must not require
 * changes to `RiskOracle`/`DetailedRiskOracle` consumers.
 */
export interface BatchRiskOracle {
  getScores(requests: BatchDestinationRequest[], options: BatchCallOptions): Promise<BatchResult>;
}

export interface BatchRiskOracleOptions {
  /** Hard cap on concurrent in-flight calls to the wrapped oracle. */
  maxConcurrency: number;
  /**
   * Minimum estimated probability, in (0, 1], that a call finishes before
   * the batch deadline for it to be admitted. Default 0.95.
   */
  targetConfidence?: number;
  /**
   * Priority units gained per millisecond spent waiting in the queue. Used
   * to prevent starvation of low-priority items under sustained
   * higher-priority load; see the class doc comment below for the bound
   * this yields.
   */
  agingRatePerMs?: number;
  /**
   * The expected span of `priority` values in use, for combining priority
   * with feasibility on a common 0..1-ish scale. Default 10.
   */
  priorityNormalization?: number;
  /** Weight given to (aged) priority in the combined admission-order score. Default 0.5. */
  priorityWeight?: number;
  /** Weight given to estimated feasibility in the combined admission-order score. Default 0.5. */
  feasibilityWeight?: number;
  /**
   * Number of most-recent per-call latencies to retain for online
   * distribution estimation. Older samples are evicted first-in-first-out,
   * which is what makes the estimate track a shifting distribution instead
   * of averaging over its entire history. Default 128.
   */
  historySize?: number;
  /** Samples required before estimates are trusted over the cold-start fallback. Default 5. */
  minSamplesForEstimate?: number;
  /** Assumed latency used only before `minSamplesForEstimate` is reached. Default 250. */
  initialLatencyEstimateMs?: number;
  logger?: Logger;
}

const MAX_POLL_MS = 250;

/**
 * Bounded-memory, recency-weighted latency distribution estimate.
 *
 * Samples are kept in a fixed-size ring buffer: once `capacity` calls have
 * completed, each new observation evicts the oldest one. This gives a hard
 * memory bound (no libraries, no unbounded history) while naturally
 * weighting recent behavior over old behavior — the estimate is always
 * "the empirical distribution of the last `capacity` calls" — which is what
 * lets it track a latency distribution that shifts over time (see
 * `quantile`/`cdf` acceptance criteria). Because it is purely empirical
 * (no assumed distribution shape), it adapts to arbitrary distribution
 * shapes rather than being tuned to e.g. log-normal specifically.
 */
class LatencyEstimator {
  private readonly buffer: number[];
  private readonly capacity: number;
  private readonly minSamples: number;
  private readonly initialEstimateMs: number;
  private writeIndex = 0;
  private count = 0;

  constructor(capacity: number, minSamples: number, initialEstimateMs: number) {
    this.capacity = Math.max(8, capacity);
    this.buffer = new Array(this.capacity);
    this.minSamples = Math.max(1, minSamples);
    this.initialEstimateMs = initialEstimateMs;
  }

  record(latencyMs: number): void {
    this.buffer[this.writeIndex] = latencyMs;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  private sorted(): number[] {
    return this.buffer.slice(0, this.count).sort((a, b) => a - b);
  }

  /** Estimated latency value `v` such that P(latency <= v) === p. */
  quantile(p: number): number {
    if (this.count < this.minSamples) {
      // Cold start: no reliable distribution yet. Widen the bound as `p`
      // grows so higher confidence targets stay conservative rather than
      // optimistically admitting on no evidence.
      return this.initialEstimateMs * (0.5 + p);
    }
    const sorted = this.sorted();
    const rank = p * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    const weight = rank - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /** Estimated P(latency <= value). */
  cdf(value: number): number {
    if (value <= 0) return 0;
    if (this.count < this.minSamples) {
      // Mirrors the quantile() cold-start fallback: treat the configured
      // initial estimate as roughly the median.
      if (value >= this.initialEstimateMs * 1.5) return 0.95;
      if (value >= this.initialEstimateMs) return 0.5;
      return 0.2;
    }
    const sorted = this.sorted();
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo / sorted.length;
  }
}

interface QueueEntry {
  destination: string;
  priority: number;
  enqueuedAt: number;
  deadlineAt: number;
  indices: number[];
  finish: (result: BatchItemResult) => void;
}

/**
 * Generic `RiskOracle` -> `BatchRiskOracle` adapter.
 *
 * Scheduling policy, in one pass per `scheduleTick()`:
 *
 * 1. **Admission (confidence-targeted deadline feasibility).** For every
 *    queued, not-yet-started item, estimate P(service latency <= time
 *    remaining until its deadline) from the live {@link LatencyEstimator}.
 *    If that probability is below `targetConfidence` — including the
 *    trivial case where time has already run out — the item is rejected
 *    immediately as `deadline-rejected` rather than started and left to
 *    blow the deadline, or left queued burning down its remaining budget
 *    for nothing. This check re-runs as real time passes (via a timer, see
 *    below), not just once at enqueue time, because an item that was
 *    feasible when queued can become infeasible purely by waiting for a
 *    concurrency slot — that queueing delay is the "current concurrency
 *    pressure" input the admission decision must account for.
 * 2. **Priority + feasibility, combined (not layered).** Among items that
 *    survive admission, the next one dispatched into a free concurrency
 *    slot is chosen by a weighted score of aged priority and estimated
 *    feasibility (`priorityWeight` / `feasibilityWeight`), not by priority
 *    alone. A high-priority item estimated unlikely to make the deadline
 *    does not automatically preempt a lower-priority item estimated very
 *    likely to make it; the weights make the tradeoff explicit and tunable
 *    instead of being an accident of iteration order.
 * 3. **Starvation freedom via aging.** A queued item's effective priority
 *    grows by `agingRatePerMs` for every millisecond it waits:
 *    `effective = priority + agingRatePerMs * waitTimeMs`. Consequently,
 *    against sustained load from items of at most `priorityNormalization`
 *    priority, any queued item's effective priority overtakes them once it
 *    has waited
 *      `(priorityNormalization - priority) / agingRatePerMs` ms,
 *    after which it wins the combined-score comparison against every
 *    freshly-arrived competitor and is the next one dispatched into a free
 *    slot. That quantity is therefore the bound on a low-priority item's
 *    expected wait *for the top of the queue*; its actual expected wait
 *    also includes however long the queue takes to produce a free slot,
 *    which is a function of `maxConcurrency` and the wrapped oracle's own
 *    latency, not of this scheduler.
 *
 * Duplicate destinations within one `getScores` call are coalesced so the
 * wrapped oracle is called at most once per distinct destination; every
 * requested occurrence still receives its own (identical) result.
 */
class BatchRiskOracleAdapter implements BatchRiskOracle {
  private readonly estimator: LatencyEstimator;
  private readonly maxConcurrency: number;
  private readonly targetConfidence: number;
  private readonly agingRatePerMs: number;
  private readonly priorityNormalization: number;
  private readonly priorityWeight: number;
  private readonly feasibilityWeight: number;
  private readonly logger: Logger;

  private readonly queue: QueueEntry[] = [];
  private inFlight = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly oracle: RiskOracle,
    options: BatchRiskOracleOptions,
  ) {
    if (!(options.maxConcurrency > 0)) {
      throw new Error('BatchRiskOracle: maxConcurrency must be a positive integer.');
    }
    this.maxConcurrency = options.maxConcurrency;
    this.targetConfidence = options.targetConfidence ?? 0.95;
    this.agingRatePerMs = options.agingRatePerMs ?? 0.01;
    this.priorityNormalization = options.priorityNormalization ?? 10;
    this.priorityWeight = options.priorityWeight ?? 0.5;
    this.feasibilityWeight = options.feasibilityWeight ?? 0.5;
    this.logger = options.logger ?? noopLogger;
    this.estimator = new LatencyEstimator(
      options.historySize ?? 128,
      options.minSamplesForEstimate ?? 5,
      options.initialLatencyEstimateMs ?? 250,
    );
  }

  async getScores(requests: BatchDestinationRequest[], options: BatchCallOptions): Promise<BatchResult> {
    if (requests.length === 0) {
      return { results: [] };
    }

    const deadlineAt = Date.now() + options.deadlineMs;
    const results: BatchItemResult[] = new Array(requests.length);
    const byDestination = new Map<string, { priority: number; indices: number[] }>();

    requests.forEach((req, index) => {
      const priority = req.priority ?? 0;
      const existing = byDestination.get(req.destination);
      if (existing) {
        existing.indices.push(index);
        existing.priority = Math.max(existing.priority, priority);
      } else {
        byDestination.set(req.destination, { priority, indices: [index] });
      }
    });

    const waits: Promise<void>[] = [];
    const now = Date.now();
    for (const [destination, meta] of byDestination) {
      waits.push(
        new Promise<void>((resolveEntry) => {
          this.queue.push({
            destination,
            priority: meta.priority,
            enqueuedAt: now,
            deadlineAt,
            indices: meta.indices,
            finish: (result) => {
              for (const index of meta.indices) results[index] = result;
              resolveEntry();
            },
          });
        }),
      );
    }

    this.scheduleTick();
    await Promise.all(waits);
    return { results };
  }

  private combinedScore(entry: QueueEntry, now: number): number {
    const agedPriority = entry.priority + this.agingRatePerMs * (now - entry.enqueuedAt);
    const normalizedPriority = agedPriority / this.priorityNormalization;
    const feasibility = this.estimator.cdf(entry.deadlineAt - now);
    return this.priorityWeight * normalizedPriority + this.feasibilityWeight * feasibility;
  }

  private scheduleTick(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }

    const now = Date.now();

    // Pass 1: drop items that could not meet the target confidence even if
    // started this instant. Waiting only shrinks their remaining budget
    // further, so they can never recover.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      const remaining = entry.deadlineAt - now;
      const probability = this.estimator.cdf(remaining);
      if (remaining <= 0 || probability < this.targetConfidence) {
        this.queue.splice(i, 1);
        this.logger.debug('BatchRiskOracle.deadlineRejected', {
          destination: entry.destination,
          remainingMs: remaining,
          estimatedProbability: probability,
        });
        entry.finish({ destination: entry.destination, status: 'deadline-rejected' });
      }
    }

    // Pass 2: fill free concurrency slots from the surviving queue, highest
    // combined score first.
    while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      let bestIndex = 0;
      let bestScore = -Infinity;
      const dispatchNow = Date.now();
      for (let i = 0; i < this.queue.length; i++) {
        const score = this.combinedScore(this.queue[i], dispatchNow);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      const [entry] = this.queue.splice(bestIndex, 1);
      this.dispatch(entry);
    }

    // If anything is still queued, wake up again right as the soonest one
    // would cross into infeasibility, so a slot never has to free up (or
    // never frees up at all) for it to be correctly rejected.
    if (this.queue.length > 0) {
      const bound = this.estimator.quantile(this.targetConfidence);
      let soonestMs = MAX_POLL_MS;
      const checkAt = Date.now();
      for (const entry of this.queue) {
        const untilInfeasible = entry.deadlineAt - checkAt - bound;
        soonestMs = Math.min(soonestMs, Math.max(0, untilInfeasible));
      }
      this.pendingTimer = setTimeout(() => this.scheduleTick(), Math.min(soonestMs, MAX_POLL_MS) || 1);
    }
  }

  private dispatch(entry: QueueEntry): void {
    this.inFlight++;
    const startedAt = Date.now();

    this.oracle
      .getScore(entry.destination)
      .then(
        (score) => {
          this.estimator.record(Date.now() - startedAt);
          entry.finish({ destination: entry.destination, status: 'fulfilled', score });
        },
        (error: unknown) => {
          this.estimator.record(Date.now() - startedAt);
          this.logger.warn('BatchRiskOracle.itemFailed', { destination: entry.destination, err: error });
          entry.finish({ destination: entry.destination, status: 'rejected', error });
        },
      )
      .finally(() => {
        this.inFlight--;
        this.scheduleTick();
      });
  }
}

/**
 * Wrap any `RiskOracle` with deadline-feasible, priority-aware batch
 * scheduling. Purely additive: `oracle` is used exactly as-is through its
 * existing `getScore` contract, so this works transparently over any
 * existing `RiskOracle`, including decorators like `CoalescingOracle` or
 * `CircuitBreakerOracle`.
 */
export function toBatchOracle(oracle: RiskOracle, options: BatchRiskOracleOptions): BatchRiskOracle {
  return new BatchRiskOracleAdapter(oracle, options);
}
