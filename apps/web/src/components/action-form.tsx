'use client';

import { useActionState, type ReactNode } from 'react';
import { InlineFailure } from '@/components/inline-failure';

/** A server action that answers with a message to show, or null when it landed. */
export type FormAction = (previous: string | null, form: FormData) => Promise<string | null>;

/**
 * A form around one decision action. The action's failure message is
 * rendered next to the form from React state, so it never travels through
 * the URL where it would be logged, bookmarked or replayed on refresh.
 */
export function ActionForm({
  action,
  className,
  children,
}: {
  action: FormAction;
  className?: string;
  children: ReactNode;
}) {
  const [failure, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className} aria-busy={pending}>
      {children}
      {failure === null ? null : <InlineFailure>{failure}</InlineFailure>}
    </form>
  );
}
