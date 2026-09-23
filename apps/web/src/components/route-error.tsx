'use client';

import { InlineFailure } from '@/components/inline-failure';

/**
 * What a route's `error.tsx` renders when its server component or one of
 * its server actions threw, which in practice means the api did not answer
 * or the page came from the build before a deploy. The message says what is
 * unchanged and what to do. Next 16 hands the boundary `retry` and still
 * passes the older `reset`; either re-renders the segment. Reloading fetches
 * the current build, which is the cure when a deploy has just landed.
 */
const LINK =
  'rounded-sm text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/45';
export function RouteError({
  error,
  reset,
  retry,
  subject,
}: {
  error: Error & { digest?: string };
  reset?: (() => void) | undefined;
  retry?: (() => void) | undefined;
  subject: string;
}) {
  const again = retry ?? reset;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-6">
      <InlineFailure className="text-sm">
        The api did not answer. {subject} is unchanged on the server and Slack still works.{' '}
        <button type="button" onClick={again} className={LINK}>
          Try again
        </button>
        ,{' '}
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className={LINK}
        >
          reload the page
        </button>{' '}
        if Lance was just updated, or check the Agents page.
      </InlineFailure>
      <p className="text-xs text-muted-foreground">
        {error.message}
        {error.digest === undefined ? '' : ` Reference ${error.digest}.`}
      </p>
    </div>
  );
}
