'use server';

import { revalidatePath } from 'next/cache';
import { apiClient } from '@/lib/trpc';

/**
 * The four decisions the Proposals pages offer (spec 12: "the same four
 * actions as Slack"). Each one is a server action: the id token stays on
 * the server, and the api's tRPC router derives the actor from the token
 * rather than from anything posted here. Each answers `useActionState`
 * with null on success or the message to show; a failure never goes into
 * the URL.
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

/** Sends the decision and refreshes the pages that show the proposal. */
async function decide(decision: Decision): Promise<string | null> {
  const failure = await send(decision);
  revalidatePath(`/proposals/${decision.proposalId}`);
  revalidatePath('/proposals');
  return failure;
}

export async function approveProposal(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  return decide({ proposalId: requiredField(form, 'proposalId'), action: 'approve' });
}

export async function snoozeProposal(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  return decide({
    proposalId: requiredField(form, 'proposalId'),
    action: 'snooze',
    snoozeHours: 4,
  });
}

export async function rejectProposal(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const note = optionalField(form, 'note');
  return decide({
    proposalId: requiredField(form, 'proposalId'),
    action: 'reject',
    reasonCode: requiredField(form, 'reasonCode'),
    ...(note === undefined ? {} : { note }),
  });
}

/** Every `field:<name>` input becomes one key of the edited payload. */
export async function editProposal(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const editedPayload: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith(EDIT_FIELD_PREFIX) && typeof value === 'string') {
      editedPayload[key.slice(EDIT_FIELD_PREFIX.length)] = value;
    }
  }

  return decide({
    proposalId: requiredField(form, 'proposalId'),
    action: 'edit',
    editedPayload,
  });
}
