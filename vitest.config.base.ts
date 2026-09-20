import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest defaults. Each package and app extends this with its own
 * vitest.config.ts via mergeConfig.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
});
