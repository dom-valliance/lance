import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

// The ledger and control suites each start a Postgres container, which is slow
// on a cold Docker cache. Hooks and tests get generous budgets; the suites run
// serially so only one container is up at a time.
export default mergeConfig(base, {
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
