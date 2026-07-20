import { describe, expect, it } from 'vitest';
import { OracleMiddleware, compose } from '../src/OracleMiddleware';
import { RiskOracle } from '../src/RiskOracle';

/** Middleware that records when the call passes through it, in both directions. */
function tracing(label: string, trace: string[]): OracleMiddleware {
  return (next) => ({
    async getScore(destination) {
      trace.push(`${label}:before`);
      const score = await next.getScore(destination);
      trace.push(`${label}:after`);
      return score;
    },
  });
}

const constantOracle = (score: number): RiskOracle => ({
  async getScore() {
    return score;
  },
});

describe('compose', () => {
  it('returns the oracle unchanged when given no middlewares', async () => {
    const oracle = constantOracle(42);

    expect(await compose()(oracle).getScore('GDEST')).toBe(42);
  });

  it('applies the first middleware as the outermost layer', async () => {
    const trace: string[] = [];
    const oracle = compose(
      tracing('outer', trace),
      tracing('middle', trace),
      tracing('inner', trace),
    )(constantOracle(7));

    const score = await oracle.getScore('GDEST');

    expect(score).toBe(7);
    expect(trace).toEqual([
      'outer:before',
      'middle:before',
      'inner:before',
      'inner:after',
      'middle:after',
      'outer:after',
    ]);
  });

  it('nests: compose(a, compose(b, c)) behaves like compose(a, b, c)', async () => {
    const nestedTrace: string[] = [];
    const flatTrace: string[] = [];

    const nested = compose(
      tracing('a', nestedTrace),
      compose(tracing('b', nestedTrace), tracing('c', nestedTrace)),
    )(constantOracle(1));
    const flat = compose(
      tracing('a', flatTrace),
      tracing('b', flatTrace),
      tracing('c', flatTrace),
    )(constantOracle(1));

    await nested.getScore('GDEST');
    await flat.getScore('GDEST');

    expect(nestedTrace).toEqual(flatTrace);
  });

  it('lets a middleware short-circuit without calling further down', async () => {
    let innerCalled = false;
    const shortCircuit: OracleMiddleware = () => ({
      async getScore() {
        return 99;
      },
    });
    const spy: OracleMiddleware = (next) => ({
      async getScore(destination) {
        innerCalled = true;
        return next.getScore(destination);
      },
    });

    const score = await compose(shortCircuit, spy)(constantOracle(1)).getScore('GDEST');

    expect(score).toBe(99);
    expect(innerCalled).toBe(false);
  });

  it('propagates errors from the oracle out through every layer', async () => {
    const trace: string[] = [];
    const failing: RiskOracle = {
      async getScore() {
        throw new Error('oracle unreachable');
      },
    };

    await expect(compose(tracing('outer', trace))(failing).getScore('GDEST')).rejects.toThrow(
      'oracle unreachable',
    );
    expect(trace).toEqual(['outer:before']);
  });
});
