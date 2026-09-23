'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InlineFailure } from '@/components/inline-failure';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { GENERATION_WAIT_MS, isGenerating, type RegenerateState } from '@/lib/brief-view';
import { formatTime } from '@/lib/time';
import { regenerateBrief } from './actions';

/** How often the page re-reads the brief while one is being generated. */
const POLL_MS = 10_000;

const IDLE: RegenerateState = { status: 'idle' };

/**
 * The Today title row with Regenerate live (design 7.1). Queuing is a
 * server action; generation happens on the worker and takes up to a
 * minute, so once the job is queued the control re-reads the page every
 * ten seconds until a brief with a new `generatedAt` arrives, and gives
 * up with a failure line after `GENERATION_WAIT_MS`. The previous brief
 * stays on the page throughout.
 */
export function TodayHeader({
  title,
  summary,
  generatedAt,
  generatedLine,
}: {
  title: string;
  summary: string;
  /** The current brief's `generatedAt`, or null when there is none. */
  generatedAt: string | null;
  /** "Brief generated 06:30 today", or null when there is no brief. */
  generatedLine: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(regenerateBrief, IDLE);
  const [gaveUpAt, setGaveUpAt] = useState<string | null>(null);

  const queued = state.status === 'queued' ? state : null;
  const generating = queued !== null && isGenerating(queued, generatedAt, gaveUpAt);

  useEffect(() => {
    if (!generating || queued === null) return;
    const poll = setInterval(() => {
      router.refresh();
    }, POLL_MS);
    const giveUp = setTimeout(() => setGaveUpAt(queued.at), GENERATION_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [generating, queued, router]);

  const busy = pending || generating;
  const label = pending ? 'Queuing' : generating ? 'Generating' : 'Regenerate';
  const line = queued !== null && generating ? `Started ${formatTime(queued.at)}` : generatedLine;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={title}
        summary={summary}
        actions={
          <form action={formAction} className="flex flex-wrap items-center gap-3" aria-busy={busy}>
            <input type="hidden" name="generatedAt" value={generatedAt ?? ''} />
            {line === null ? null : <span className="text-xs text-muted-foreground">{line}</span>}
            <Button type="submit" variant="outline" disabled={busy} aria-busy={busy}>
              {busy ? <Spinner /> : null}
              {label}
            </Button>
          </form>
        }
      />

      {generating ? (
        <p
          role="status"
          className="flex items-start gap-3 rounded-lg border border-sem-peach-line bg-sem-peach-bg px-4 py-3 text-sm text-brand"
        >
          <Spinner className="mt-0.5 size-4 shrink-0" />
          <span>
            Generating the brief. The planner is reading the calendar, recent mail, Notion and the
            last Jamie read. Usually under a minute.
            {generatedAt === null ? '' : ' The previous brief stays below until it is replaced.'}
          </span>
        </p>
      ) : null}

      {state.status === 'failed' ? <InlineFailure>{state.message}</InlineFailure> : null}

      {queued !== null && gaveUpAt === queued.at && queued.previousGeneratedAt === generatedAt ? (
        <InlineFailure>
          The brief has not arrived after three minutes. Look at the brief-morning queue in the
          observing runbook, section 2.
        </InlineFailure>
      ) : null}
    </div>
  );
}
