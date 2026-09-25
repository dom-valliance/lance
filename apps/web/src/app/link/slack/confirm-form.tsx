'use client';

import { useActionState } from 'react';
import { Link2 } from 'lucide-react';
import { InlineFailure } from '@/components/inline-failure';
import { SubmitButton } from '@/components/submit-button';
import { outcomeMessage } from '@/lib/slack-link-view';
import { confirmSlackLinkAction } from './actions';
import { LinkMessageView } from './link-message';

/**
 * The one button that binds the Slack account. The outcome the api returns
 * replaces the form, from React state; a reload shows the standing link
 * from the api instead.
 */
export function ConfirmForm({ token, agentName }: { token: string; agentName: string }) {
  const [state, action, pending] = useActionState(confirmSlackLinkAction, null);

  if (state !== null && 'outcome' in state) {
    const message = outcomeMessage(state.outcome, agentName);
    const warnings = state.outcome.status === 'linked' ? state.outcome.warnings : [];
    return <LinkMessageView message={message} warnings={warnings} />;
  }

  return (
    <form action={action} aria-busy={pending} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <SubmitButton size="lg" className="w-full" pendingLabel="Linking">
        <Link2 aria-hidden />
        Link this Slack account
      </SubmitButton>
      {state !== null && 'failure' in state ? <InlineFailure>{state.failure}</InlineFailure> : null}
    </form>
  );
}
