import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Keep the local Soroban RPC integration suite (tests/integration) out of
    // the fast unit run: it runs via its own `test:integration` script and a
    // dedicated required CI job (see .github/workflows/ci.yml).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'tests/integration/**/*.test.ts',
    ],
    // `tests/benchmarks/fixtureStreaming.budget.test.ts` needs `global.gc()`
    // to get low-noise heap measurements when comparing the incremental
    // parser's peak memory against a deliberately-materialize-twice
    // baseline.
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
});
