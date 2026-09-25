'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth, updateSession } from '@/auth';
import { serverIdToken } from '@/auth/id-token';
import { apiBaseUrl } from '@/lib/api';
import { submitJamieKey } from '@/lib/jamie-key';
import { dataProcessingNotice } from '@/lib/notice';
import { readPreferencesForm } from '@/lib/onboarding-view';
import { apiClient } from '@/lib/trpc';

/**
 * The onboarding checklist's writes (docs/plans/multi-user.md M3). Each one
 * answers `useActionState` with null when it landed or a sentence to show
 * under its form, so a failure never travels through the URL (root
 * CLAUDE.md gotcha). The api records every step in the ledger.
 */

const ONBOARDING = '/onboarding';

/** Runs one api call and refreshes the checklist either way. */
async function run(mutate: () => Promise<unknown>, fallback: string): Promise<string | null> {
  try {
    await mutate();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : fallback;
  } finally {
    revalidatePath(ONBOARDING);
  }
}

/** Step 1: records the SHA-256 of the notice this build shows, never one from the form. */
export async function acceptNoticeAction(): Promise<string | null> {
  const { sha256 } = dataProcessingNotice();
  return run(async () => {
    const client = await apiClient();
    await client.onboarding.acceptNotice.mutate({ noticeSha256: sha256 });
  }, 'The acceptance could not be recorded. Try again.');
}

/**
 * Step 3: the key goes to the api's test call and Key Vault. It is read
 * from the form here and handed on, and appears in no log line or message.
 */
export async function saveJamieKeyAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const value = form.get('apiKey');
  const session = await auth();
  const idToken =
    session === null || session.error !== undefined ? undefined : await serverIdToken();
  if (idToken === undefined) {
    return 'Your sign-in has lapsed. Sign in again, then add the key. Nothing was stored.';
  }
  try {
    return await submitJamieKey({
      apiKey: typeof value === 'string' ? value : '',
      idToken,
      apiBaseUrl: apiBaseUrl(),
    });
  } finally {
    revalidatePath(ONBOARDING);
  }
}

/** Step 6: the quiet hours and time zone as the principal confirmed or changed them. */
export async function confirmPreferencesAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const read = readPreferencesForm(form);
  if (!read.ok) return read.failure;
  return run(async () => {
    const client = await apiClient();
    await client.onboarding.confirmPreferences.mutate(read.value);
  }, 'Your quiet hours could not be saved. Try again.');
}

/**
 * Completion. The api checks every step again and activates the principal;
 * the session's status is then renewed so the proxy lets them into the app.
 */
export async function completeOnboardingAction(): Promise<string | null> {
  const { sha256 } = dataProcessingNotice();
  const failure = await run(async () => {
    const client = await apiClient();
    await client.onboarding.complete.mutate({ noticeSha256: sha256 });
  }, 'Onboarding could not be finished. Nothing was changed; try again.');
  if (failure !== null) return failure;
  await updateSession({});
  revalidatePath('/', 'layout');
  redirect('/');
}
