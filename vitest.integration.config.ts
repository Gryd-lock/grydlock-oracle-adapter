import { defineConfig } from 'vitest/config';

// Dedicated config for the local Soroban RPC integration suite, so it can be
// run independently of the fast unit tests (npm run test:integration) and as
// a required CI job. These tests start a local in-process Soroban RPC
// fixture server bound to 127.0.0.1 and need no external network access.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    pool: 'forks',
  },
});
