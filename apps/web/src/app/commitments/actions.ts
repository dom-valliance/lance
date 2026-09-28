'use server';

import { revalidatePath } from 'next/cache';
import {
  COMMITMENT_STATUSES,
  commitmentHref,
  NOT_MINE_REASON,
  type CommitmentStatus,
} from '@/lib/commitment-view';
import { apiClient } from '@/lib/trpc';

/**
 * The decisions the Commitments pages offer (spec 12: "chase button, mark
 * done, drop with reason"; ADR 0036: edit, any status change, notes), one
 * server action each, following the
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

const optionalField = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Runs the mutation and refreshes the list and the commitment's page either way. */
async function run(id: string, mutate: () => Promise<unknown>): Promise<string | null> {
  try {
    await mutate();
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The action could not be applied. Check the api logs.';
  } finally {
    revalidatePath('/commitments');
    revalidatePath(commitmentHref(id));
  }
}

const isStatus = (value: string): value is CommitmentStatus =>
  (COMMITMENT_STATUSES as readonly string[]).includes(value);

export async function markCommitmentDone(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const client = await apiClient();
  return run(id, () => client.commitments.markDone.mutate({ id }));
}

export async function dropCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const reason = requiredField(form, 'reason');
  const client = await apiClient();
  return run(id, () => client.commitments.drop.mutate({ id, reason }));
}

export async function chaseCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const client = await apiClient();
  return run(id, () => client.commitments.chase.mutate({ id }));
}

export async function setCommitmentStatus(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const to = requiredField(form, 'status');
  if (!isStatus(to)) return `"${to}" is not a commitment status. Choose one from the list.`;
  const reason = optionalField(form, 'reason');
  if (to === 'dropped' && reason === undefined) {
    return 'Give a reason to drop this commitment; it is kept in the ledger.';
  }
  const client = await apiClient();
  return run(id, () =>
    client.commitments.setStatus.mutate({ id, to, ...(reason === undefined ? {} : { reason }) }),
  );
}

/**
 * Saves the description and the due date together. An empty date clears
 * it; the api writes nothing for a field that did not change.
 */
export async function editCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const description = optionalField(form, 'description');
  if (description === undefined) return 'Write what was promised before saving.';
  const dueDay = optionalField(form, 'dueDay') ?? null;
  const client = await apiClient();
  return run(id, () => client.commitments.edit.mutate({ id, description, dueDay }));
}

export async function addCommitmentNote(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const body = optionalField(form, 'body');
  if (body === undefined) return 'Write the note before adding it.';
  const client = await apiClient();
  return run(id, () => client.commitments.addNote.mutate({ id, body }));
}

/** Triage: the principal says the promise was made to them, so it opens (ADR 0037). */
export async function confirmCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const client = await apiClient();
  return run(id, () => client.commitments.setStatus.mutate({ id, to: 'open' }));
}

/** Triage: the promise was made to someone else, so it is dropped with that reason. */
export async function dismissCommitment(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const id = requiredField(form, 'commitmentId');
  const client = await apiClient();
  return run(id, () =>
    client.commitments.setStatus.mutate({ id, to: 'dropped', reason: NOT_MINE_REASON }),
  );
}
