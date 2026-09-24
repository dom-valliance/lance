import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

// Suites here start Postgres containers or load modules that are slow when
// every package tests at once, so tests and hooks get the budgets the db,
// ledger and api suites already have.
export default mergeConfig(base, {
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
