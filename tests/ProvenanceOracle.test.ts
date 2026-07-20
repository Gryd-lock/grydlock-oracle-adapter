import { describe, expect, it } from 'vitest';
import { StubOracle } from '../src/StubOracle';
import { ProvenanceOracle, ScoreProvenance } from '../src/ProvenanceOracle';
import { DetailedRiskOracle, RiskOracle, ScoredResult } from '../src/RiskOracle';
import { LogFields, Logger } from '../src/Logger';

const MALICIOUS_DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';

interface CapturedEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: LogFields;
}

function capturingLogger(): { logger: Logger; entries: CapturedEntry[] } {
  const entries: CapturedEntry[] = [];
  const capture = (level: CapturedEntry['level']) => (message: string, fields?: LogFields) => {
    entries.push({ level, message, fields });
  };
  return {
    logger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    },
    entries,
  };
}

/** Deterministic clock advancing a fixed step per call. */
function tickingClock(start: number, stepMs: number): () => number {
  let current = start - stepMs;
  return () => {
    current += stepMs;
    return current;
  };
}

describe('ProvenanceOracle', () => {
  it('returns the same score as the wrapped oracle without callers changing getScore usage', async () => {
    const inner = new StubOracle();
    const wrapped = new ProvenanceOracle(inner, { logger: capturingLogger().logger });

    expect(await wrapped.getScore(MALICIOUS_DESTINATION)).toBe(
      await inner.getScore(MALICIOUS_DESTINATION),
    );
  });

  it('emits one structured provenance entry per getScore call with source, timestamp, cache status and latency', async () => {
    const { logger, entries } = capturingLogger();
    const oracle = new ProvenanceOracle(new StubOracle(), {
      logger,
      now: tickingClock(1_000, 5),
    });

    const score = await oracle.getScore(MALICIOUS_DESTINATION);

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].message).toBe('score_provenance');

    const provenance = entries[0].fields as unknown as ScoreProvenance;
    expect(provenance.event).toBe('score_provenance');
    expect(provenance.destination).toBe(MALICIOUS_DESTINATION);
    expect(provenance.score).toBe(score);
    expect(provenance.source).toBe('StubOracle');
    expect(provenance.cacheStatus).toBe('unknown');
    expect(provenance.outcome).toBe('success');
    expect(typeof provenance.timestamp).toBe('number');
    expect(provenance.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('emits provenance for getScoreDetailed calls as well', async () => {
    const { logger, entries } = capturingLogger();
    const oracle = new ProvenanceOracle(new StubOracle(), { logger });

    const result = await oracle.getScoreDetailed(MALICIOUS_DESTINATION);

    expect(result.score).toBe(95);
    expect(result.source).toBe('StubOracle');
    expect(entries).toHaveLength(1);
    expect((entries[0].fields as unknown as ScoreProvenance).outcome).toBe('success');
  });

  it('honors an explicit source label', async () => {
    const { logger, entries } = capturingLogger();
    const oracle = new ProvenanceOracle(new StubOracle(), {
      logger,
      source: 'stub-fixtures',
    });

    await oracle.getScore(MALICIOUS_DESTINATION);

    expect((entries[0].fields as unknown as ScoreProvenance).source).toBe('stub-fixtures');
  });

  it('uses the wrapped oracle’s own source and cache status when it reports metadata', async () => {
    const detailedInner: DetailedRiskOracle = {
      async getScore() {
        return 42;
      },
      async getScoreDetailed(): Promise<ScoredResult> {
        return {
          score: 42,
          timestamp: 123,
          source: 'soroban',
          cacheStatus: 'cache-stale',
        };
      },
    };
    const { logger, entries } = capturingLogger();
    const oracle = new ProvenanceOracle(detailedInner, { logger });

    const score = await oracle.getScore('GDEST');

    expect(score).toBe(42);
    const provenance = entries[0].fields as unknown as ScoreProvenance;
    expect(provenance.source).toBe('soroban');
    expect(provenance.cacheStatus).toBe('cache-stale');
  });

  it('rethrows inner failures unchanged and records an error provenance entry', async () => {
    const failing: RiskOracle = {
      async getScore() {
        throw new Error('oracle unreachable');
      },
    };
    const { logger, entries } = capturingLogger();
    const oracle = new ProvenanceOracle(failing, { logger, source: 'soroban' });

    await expect(oracle.getScore('GDEST')).rejects.toThrow('oracle unreachable');

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('error');
    const provenance = entries[0].fields as unknown as ScoreProvenance;
    expect(provenance.outcome).toBe('error');
    expect(provenance.score).toBeNull();
    expect(provenance.error).toBe('oracle unreachable');
    expect(provenance.source).toBe('soroban');
  });

  it('measures latency with the injected clock', async () => {
    const { logger, entries } = capturingLogger();
    const oracle = new ProvenanceOracle(new StubOracle(), {
      logger,
      now: tickingClock(50_000, 7),
    });

    await oracle.getScore(MALICIOUS_DESTINATION);

    const provenance = entries[0].fields as unknown as ScoreProvenance;
    expect(provenance.latencyMs).toBeGreaterThan(0);
    expect(provenance.latencyMs % 7).toBe(0);
  });

  it('defaults to the no-op logger so wrapping without options is safe', async () => {
    const oracle = new ProvenanceOracle(new StubOracle());

    await expect(oracle.getScore(MALICIOUS_DESTINATION)).resolves.toBe(95);
  });
});
