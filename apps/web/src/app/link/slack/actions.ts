'use server';

import { signIn } from '@/auth';
import type { SlackLinkOutcome } from '@/lib/slack-link-view';
import { apiClient } from '@/lib/trpc';

/**
 * The two steps the `/link/slack` page offers (ADR 0021). The confirmation
 * answers `useActionState` with the api's outcome, so the result is shown
 * from server state and nothing but the link's own token is ever in the
 * URL (root CLAUDE.md gotcha).
 */

const readToken = (form: FormData): string => {
  const value = form.get('token');
  return typeof value === 'string' ? value : '';
};

/** Signs in with Entra and comes back to the same link. */
export async function signInToLinkAction(form: FormData): Promise<void> {
  const token = readToken(form);
  const back = new URLSearchParams({ state: token });
  await signIn('microsoft-entra-id', { redirectTo: `/link/slack?${back.toString()}` });
}

export type ConfirmState = { outcome: SlackLinkOutcome } | { failure: string } | null;

export async function confirmSlackLinkAction(
  _previous: ConfirmState,
  form: FormData,
): Promise<ConfirmState> {
  const token = readToken(form);
  if (token === '') {
    return { failure: 'The link is incomplete. Run /lance login in Slack for a new one.' };
  }
  try {
    const client = await apiClient();
    return { outcome: await client.slackLink.confirm.mutate({ token }) };
  } catch (error) {
    return {
      failure:
        error instanceof Error
          ? `The link could not be confirmed: ${error.message}`
          : 'The link could not be confirmed. Nothing was changed; try again.',
    };
  }
}
