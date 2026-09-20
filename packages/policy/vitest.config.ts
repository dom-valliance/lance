import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

/** Spec section 6 requires 100 percent branch coverage on the policy engine. */
export default mergeConfig(base, {
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
