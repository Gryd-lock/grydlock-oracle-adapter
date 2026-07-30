import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // `tests/benchmarks/fixtureStreaming.budget.test.ts` needs `global.gc()`
    // to get low-noise heap measurements when comparing the incremental
    // parser's peak memory against a deliberately-materialize-twice
    // baseline.
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
});
