'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiClient } from '@/lib/trpc';

/**
 * The four decisions the Proposals pages offer (spec 12: "the same four
 * actions as Slack"). Each one is a server action: the id token stays on
 * the server, and the api's tRPC router derives the actor from the token
 * rather than from anything posted here.
 */

const EDIT_FIELD_PREFIX = 'field:';

interface Decision {
  proposalId: string;
  action: 'approve' | 'edit' | 'reject' | 'snooze';
  note?: string;
  reasonCode?: string;
  editedPayload?: Record<string, unknown>;
  snoozeHours?: number;
}

const requiredField = (form: FormData, name: string): string => {
  const value = form.get(name);
  if (typeof value !== 'string' || value === '') {
    throw new Error(`The form did not carry "${name}". Reload the proposal and try again.`);
  }
  return value;
};

const optionalField = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/** Returns null when the decision landed, or a message to show the user. */
async function send(decision: Decision): Promise<string | null> {
  const client = await apiClient();
  try {
    await client.proposals.decide.mutate(decision);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The decision could not be applied. Check the api logs.';
  }
}

/** `redirect` throws by design, so it is called outside the try in `send`. */
async function decideThenReturn(decision: Decision): Promise<never> {
  const failure = await send(decision);
  revalidatePath(`/proposals/${decision.proposalId}`);
  revalidatePath('/proposals');
  redirect(
    failure === null
      ? `/proposals/${decision.proposalId}`
      : `/proposals/${decision.proposalId}?error=${encodeURIComponent(failure)}`,
  );
}

export async function approveProposal(form: FormData): Promise<void> {
  await decideThenReturn({ proposalId: requiredField(form, 'proposalId'), action: 'approve' });
}

export async function snoozeProposal(form: FormData): Promise<void> {
  await decideThenReturn({
    proposalId: requiredField(form, 'proposalId'),
    action: 'snooze',
    snoozeHours: 4,
  });
}

export async function rejectProposal(form: FormData): Promise<void> {
  const note = optionalField(form, 'note');
  await decideThenReturn({
    proposalId: requiredField(form, 'proposalId'),
    action: 'reject',
    reasonCode: requiredField(form, 'reasonCode'),
    ...(note === undefined ? {} : { note }),
  });
}

/** Every `field:<name>` input becomes one key of the edited payload. */
export async function editProposal(form: FormData): Promise<void> {
  const editedPayload: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith(EDIT_FIELD_PREFIX) && typeof value === 'string') {
      editedPayload[key.slice(EDIT_FIELD_PREFIX.length)] = value;
    }
  }

  await decideThenReturn({
    proposalId: requiredField(form, 'proposalId'),
    action: 'edit',
    editedPayload,
  });
}
