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
    // The root test run starts every package at once, and on a laptop a
    // five second default fails fast tests that are merely waiting their
    // turn. Packages that start containers set more.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
