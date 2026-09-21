'use server';

import { revalidatePath } from 'next/cache';
import { commitmentsRouter } from '@/lib/commitment-view';
import { apiClient } from '@/lib/trpc';

/**
 * The three decisions the Commitments page offers (spec 12: "chase button,
 * mark done, drop with reason"), one server action each, following the
 * shape of `apps/web/src/app/proposals/actions.ts`: the id token stays on
 * the server, and each action answers `useActionState` with null on
 * success or a message to show. A failure never travels through the URL
 * (root CLAUDE.md gotcha: "a failure message never travels in a URL").
 */

const requiredField = (form: FormData, name: string): string => {
  const value = form.get(name);
  if (typeof value !== 'string' || value === '') {
    throw new Error(`The form did not carry "${name}". Reload the page and try again.`);
  }
  return value;
};

/** Runs the mutation and refreshes the commitments list either way. */
async function run(mutate: () => Promise<unknown>): Promise<string | null> {
  try {
    await mutate();
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The action could not be applied. Check the api logs.';
  } finally {
    revalidatePath('/commitments');
  }
}

export async function markCommitmentDone(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const client = await apiClient();
  return run(() => commitmentsRouter(client).markDone.mutate({ id }));
}

export async function dropCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const reason = requiredField(form, 'reason');
  const client = await apiClient();
  return run(() => commitmentsRouter(client).drop.mutate({ id, reason }));
}

export async function chaseCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const client = await apiClient();
  return run(() => commitmentsRouter(client).chase.mutate({ id }));
}
