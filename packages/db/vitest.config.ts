import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

// The migration suite starts a Postgres container, which is slow on a cold
// Docker cache. Hooks and tests get generous budgets; the suite runs serially
// so a single container is shared.
export default mergeConfig(base, {
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
