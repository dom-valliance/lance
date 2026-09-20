import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

// src/main.test.ts starts a Postgres container, which is slow on a cold
// Docker cache. Hooks and tests get generous budgets; the suite runs
// serially so the container is started once.
export default mergeConfig(base, {
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
