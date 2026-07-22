import {
  CacheStatus,
  DetailedRiskOracle,
  OracleSource,
  RiskOracle,
  ScoredResult,
} from './RiskOracle';
import { Logger, noopLogger } from './Logger';

/**
 * Structured audit record emitted for every score resolved (or failed)
 * through a ProvenanceOracle. Answers "why did the user see this score"
 * after the fact.
 */
export interface ScoreProvenance {
  /** Discriminant tag identifying this record shape in a log stream. */
  event: 'score_provenance';
  /** The Stellar address or asset that was scored. */
  destination: string;
  /** The resolved score, or null when the call failed. */
  score: number | null;
  /** Which oracle/tier answered. */
  source: OracleSource;
  /** Whether the score was live, cached, stale, or a fallback default. */
  cacheStatus: CacheStatus;
  /** Epoch milliseconds at which the call completed. */
  timestamp: number;
  /** Wall-clock duration of the call in milliseconds. */
  latencyMs: number;
  /** Whether the underlying call succeeded or threw. */
  outcome: 'success' | 'error';
  /** Present when outcome is "error": the stringified inner failure. */
  error?: string;
}

/** Options controlling a {@link ProvenanceOracle}. */
export interface ProvenanceOracleOptions {
  /**
   * Label used as the provenance source when the wrapped oracle cannot
   * report one itself. Defaults to the wrapped oracle's class name.
   */
  source?: OracleSource;
  /** Destination for provenance records. Defaults to the no-op logger. */
  logger?: Logger;
  /** Clock returning epoch milliseconds. Injectable for tests. */
  now?: () => number;
}

function isDetailed(oracle: RiskOracle): oracle is DetailedRiskOracle {
  return typeof (oracle as Partial<DetailedRiskOracle>).getScoreDetailed === 'function';
}

/**
 * Decorator that adds a provenance audit trail to any RiskOracle.
 *
 * Every getScore/getScoreDetailed call emits one structured
 * {@link ScoreProvenance} record through the injected logger — at `info` on
 * success, `error` on failure — then returns (or rethrows) the inner
 * oracle's result unchanged. Callers keep their existing `getScore(dest)`
 * usage; wrapping the oracle once at construction time is the only change:
 *
 * ```ts
 * const oracle = new ProvenanceOracle(new StubOracle(), { logger });
 * const score = await oracle.getScore(dest); // same number as before
 * ```
 *
 * If the wrapped oracle implements getScoreDetailed (see DetailedRiskOracle),
 * its reported source and cache status are used; otherwise the record falls
 * back to the configured source label and an "unknown" cache status.
 */
export class ProvenanceOracle implements DetailedRiskOracle {
  private readonly inner: RiskOracle;
  private readonly source: OracleSource;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(inner: RiskOracle, options: ProvenanceOracleOptions = {}) {
    this.inner = inner;
    this.source = options.source ?? inner.constructor.name;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? Date.now;
  }

  async getScore(destination: string): Promise<number> {
    const result = await this.resolveWithProvenance(destination);
    return result.score;
  }

  /**
   * @param destination A Stellar address or asset identifier.
   * @returns The inner oracle's detailed result, after emitting a
   * {@link ScoreProvenance} record for the call.
   */
  async getScoreDetailed(destination: string): Promise<ScoredResult> {
    return this.resolveWithProvenance(destination);
  }

  private async resolveWithProvenance(destination: string): Promise<ScoredResult> {
    const start = this.now();
    try {
      const result = isDetailed(this.inner)
        ? await this.inner.getScoreDetailed(destination)
        : {
            score: await this.inner.getScore(destination),
            timestamp: this.now(),
            source: this.source,
            cacheStatus: 'unknown' as const,
          };
      this.emit({
        event: 'score_provenance',
        destination,
        score: result.score,
        source: result.source,
        cacheStatus: result.cacheStatus,
        timestamp: this.now(),
        latencyMs: this.now() - start,
        outcome: 'success',
      });
      return result;
    } catch (err) {
      this.emit({
        event: 'score_provenance',
        destination,
        score: null,
        source: this.source,
        cacheStatus: 'unknown',
        timestamp: this.now(),
        latencyMs: this.now() - start,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private emit(provenance: ScoreProvenance): void {
    if (provenance.outcome === 'error') {
      this.logger.error('score_provenance', { ...provenance });
    } else {
      this.logger.info('score_provenance', { ...provenance });
    }
  }
}
