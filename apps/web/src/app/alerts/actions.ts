'use server';

import { revalidatePath } from 'next/cache';
import { MUTE_HOURS } from '@/lib/alert-view';
import { apiClient } from '@/lib/trpc';

/**
 * The three state changes the Alerts page offers (spec 11: "Ack resolves
 * the Slack card and the UI row. Mute suppresses the dedupe key for the
 * period and is itself a ledger event."), one server action each,
 * following the shape of `apps/web/src/app/commitments/actions.ts`: the id
 * travels as a hidden form field, and each action answers
 * `useActionState` with null on success or a message to show.
 */

const requiredId = (form: FormData): string => {
  const value = form.get('alertId');
  if (typeof value !== 'string' || value === '') {
    throw new Error('The form did not carry an alert id. Reload the page and try again.');
  }
  return value;
};

/** Runs the mutation and refreshes the alerts list either way. */
async function run(mutate: () => Promise<unknown>): Promise<string | null> {
  try {
    await mutate();
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The action could not be applied. Check the api logs.';
  } finally {
    revalidatePath('/alerts');
  }
}

export async function ackAlert(_previous: string | null, form: FormData): Promise<string | null> {
  const id = requiredId(form);
  const client = await apiClient();
  return run(() => client.alerts.ack.mutate({ id }));
}

export async function muteAlert(_previous: string | null, form: FormData): Promise<string | null> {
  const id = requiredId(form);
  const client = await apiClient();
  return run(() => client.alerts.mute.mutate({ id, hours: MUTE_HOURS }));
}

export async function resolveAlert(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredId(form);
  const client = await apiClient();
  return run(() => client.alerts.resolve.mutate({ id }));
}
