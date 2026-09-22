import { expect, test } from '@playwright/test';

// These tests never attempt a real Entra sign-in: they only check that an
// unauthenticated visitor is turned back at the door, and that the Entra
// provider is the one wired up behind that door.
//
// This file sits outside tsconfig.json's "include" and the root ESLint
// config's TypeScript-aware globs (both scope to apps/*/src), so it
// deliberately avoids TS-only syntax such as `as` casts and type
// annotations; Playwright still type-checks it on its own via esbuild.

test('visiting /today unauthenticated redirects to the sign-in page', async ({ page }) => {
  await page.goto('/today');

  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('button', { name: /continue with microsoft/i })).toBeVisible();
});

test('the providers endpoint lists microsoft-entra-id', async ({ request }) => {
  const response = await request.get('/api/auth/providers');
  expect(response.ok()).toBe(true);

  const body = await response.json();
  expect(Object.keys(body)).toContain('microsoft-entra-id');
});

test('visiting /proposals unauthenticated redirects to the sign-in page', async ({ page }) => {
  await page.goto('/proposals');

  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('button', { name: /continue with microsoft/i })).toBeVisible();
});

test('visiting /ledger unauthenticated redirects to the sign-in page', async ({ page }) => {
  await page.goto('/ledger');

  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('button', { name: /continue with microsoft/i })).toBeVisible();
});
