import { defineConfig } from 'vitest/config';

// Used only by `npm run test:mutation`. Stryker's vitest runner forces the
// `threads` pool (see its createVitest options), but the main config's
// `execArgv: ['--expose-gc']` cannot be inherited by thread workers on every
// platform (worker_threads is unreliable with V8 flags like --expose-gc).
// This config therefore runs the threads pool without execArgv, and excludes
// the benchmark suite — its latency/memory budgets depend on global.gc()
// from --expose-gc and assert on performance rather than mutation-relevant
// logic.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/benchmarks/**'],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 1,
        minThreads: 1,
      },
    },
  },
});
