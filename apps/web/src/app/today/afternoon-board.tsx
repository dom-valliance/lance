import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ProvenanceLink } from '@/components/provenance';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import {
  audienceLabel,
  countLabel,
  decidedLabel,
  expiresSoon,
  listSentence,
  type AfternoonBoardContent,
} from '@/lib/brief-view';
import { expiryLabel, formatTime } from '@/lib/time';
import { Dot, GroupHeading } from './section-card';

/** One line of a dot list: the dot's colour and its sentence. */
function DotLine({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <li className="flex gap-2 text-sm">
      <Dot className={tone} />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * Spec 10.2: what moved since the morning brief, what is still waiting on
 * Dom, and tomorrow's first meeting. Nothing else. The board joins the
 * page at 16:00 and re-renders on the same live stream as the day above
 * it, so a decision taken in Slack empties the pending column here.
 */
export function AfternoonBoardSection({ board, now }: { board: AfternoonBoardContent; now: Date }) {
  const { moved, pending, tomorrowFirstMeeting: tomorrow } = board;
  const decided =
    moved.proposalsDecided.approved +
    moved.proposalsDecided.edited +
    moved.proposalsDecided.rejected;
  const movedCount = moved.tasksCompleted.length + decided + moved.commitmentsClosed.length;

  return (
    <section className="flex flex-col gap-4 rounded-xl border-t-2 border-brand bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Afternoon board</h2>
        <p className="text-xs text-muted-foreground">
          Since the brief at {formatTime(board.since)}. Appears after 16:00, refreshes live.
        </p>
      </div>

      <div className="hidden gap-6 lg:grid lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <GroupHeading>What moved</GroupHeading>
          {movedCount === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing has moved since the brief.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {moved.tasksCompleted.map((task) => (
                <DotLine key={task.taskId} tone="bg-sem-green-fg">
                  <TextLink href={task.url ?? '/tasks'} tone="foreground">
                    {task.title}
                  </TextLink>
                </DotLine>
              ))}
              {decided === 0 ? null : (
                <DotLine tone="bg-sem-blue-fg">
                  {decidedLabel(moved.proposalsDecided)}{' '}
                  <TextLink href="/proposals">Queue</TextLink>
                </DotLine>
              )}
              {moved.commitmentsClosed.map((commitment) => (
                <DotLine key={commitment.commitmentId} tone="bg-sem-green-fg">
                  <TextLink href="/commitments" tone="foreground">
                    {commitment.description}
                  </TextLink>
                </DotLine>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <GroupHeading>Still pending decision, {pending.length}</GroupHeading>
          {pending.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing is waiting on you.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((proposal) => (
                <DotLine key={proposal.proposalId} tone="bg-brand">
                  <TextLink href={`/proposals/${proposal.proposalId}`} tone="foreground">
                    {proposal.preview}
                  </TextLink>
                  <span
                    className={cn(
                      'mt-0.5 block text-xs',
                      expiresSoon(proposal.expiresAt, now) ? 'text-brand' : 'text-muted-foreground',
                    )}
                  >
                    {expiryLabel(proposal.expiresAt, now)}
                  </span>
                </DotLine>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <GroupHeading>Tomorrow's first meeting</GroupHeading>
          {tomorrow === null ? (
            <p className="text-xs text-muted-foreground">Tomorrow has no meetings yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                {formatTime(tomorrow.start)}, {tomorrow.title}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{audienceLabel(tomorrow.audience, tomorrow.counterpartyClass)}</span>
                {tomorrow.attendees.length === 0 ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span>{listSentence(tomorrow.attendees)}</span>
                  </>
                )}
                <span aria-hidden>·</span>
                <ProvenanceLink source={tomorrow.provenance} seen={false} />
              </p>
              {tomorrow.prepExists && tomorrow.prepBriefId !== null ? (
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="green" size="sm" dot>
                    Prep exists
                  </Badge>
                  <TextLink href="/today">Open the prep</TextLink>
                </p>
              ) : (
                <Badge tone="outline" size="sm" className="self-start">
                  No prep yet
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground lg:hidden">
        {countLabel(movedCount, 'thing')} moved since the brief <span aria-hidden>·</span>{' '}
        <TextLink href="/proposals">{countLabel(pending.length, 'decision')} pending</TextLink>
        {tomorrow === null
          ? '.'
          : `. Tomorrow opens at ${formatTime(tomorrow.start)} with ${tomorrow.title}.`}
      </p>
    </section>
  );
}
