import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

// Chromium only per WP0.10: this suite proves the shell's auth guard and
// the Entra provider wiring, not cross-browser rendering.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    // Always start a fresh server: this file sits outside the root ESLint
    // config's Node-aware globs (scoped to apps/*/src), so it does not have
    // the `process` global available to branch on CI here.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AUTH_SECRET: 'test-secret',
      ENTRA_TENANT_ID: 'common',
      ENTRA_CLIENT_ID: 'test',
      ENTRA_CLIENT_SECRET: 'test',
      ALLOWED_UPN: 'dom@valliance.ai',
    },
  },
});
