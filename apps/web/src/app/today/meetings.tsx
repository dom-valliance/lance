import { cn } from 'cn';
import { Ageing } from '@/components/ageing';
import { EmptyState } from '@/components/empty-state';
import { ProvenanceLink } from '@/components/provenance';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import {
  audienceLabel,
  commitmentAgeing,
  countLabel,
  formatDayMonth,
  interactionLabel,
  invertVisibility,
  isPrepExpanded,
  meetingVisibility,
  nextMeetingId,
  type Attendee,
  type Meeting,
  type Visibility,
} from '@/lib/brief-view';
import { formatTime, relativeTo } from '@/lib/time';
import { GroupHeading, SectionCard } from './section-card';

/**
 * A meeting's prep is open on the prep clock at desktop width and on the
 * next meeting alone at phone width, so both layouts come from one pass of
 * the same data: these three maps turn a `Visibility` into the pair of
 * Tailwind classes that show it at one width and hide it at the other.
 */
const BLOCK_CLASS: Record<Visibility, string> = {
  both: 'grid',
  desktop: 'hidden lg:grid',
  phone: 'grid lg:hidden',
  none: 'hidden',
};

const TEXT_CLASS: Record<Visibility, string> = {
  both: 'block',
  desktop: 'hidden lg:block',
  phone: 'block lg:hidden',
  none: 'hidden',
};

const INLINE_CLASS: Record<Visibility, string> = {
  both: 'inline',
  desktop: 'hidden lg:inline',
  phone: 'inline lg:hidden',
  none: 'hidden',
};

/**
 * A meeting with its prep open is a 16px semibold heading; a summarised
 * one is a 14px medium line (design 7.1), at each width independently.
 */
function titleClass(prep: Visibility): string {
  const openOnPhone = prep === 'both' || prep === 'phone';
  const openOnDesktop = prep === 'both' || prep === 'desktop';
  return cn(
    openOnPhone ? 'text-base font-semibold' : 'text-sm font-medium',
    openOnDesktop ? 'lg:text-base lg:font-semibold' : 'lg:text-sm lg:font-medium',
  );
}

/**
 * What the summarised row says between the times and the provenance
 * (design 7.1): who is coming, and how many commitments are open with
 * them. Nothing is said about an empty list, so the line never carries an
 * empty slot.
 */
function summaryParts(meeting: Meeting): string[] {
  const parts: string[] = [];
  if (meeting.attendees.length > 0) {
    parts.push(meeting.attendees.map((attendee) => attendee.name).join(', '));
  }
  if (meeting.commitments.length > 0) {
    parts.push(countLabel(meeting.commitments.length, 'open commitment'));
  }
  return parts;
}

const attendeeKey = (attendee: Attendee): string =>
  attendee.personId ?? attendee.email ?? attendee.name;

const roleLine = (attendee: Attendee): string =>
  [attendee.role, attendee.organisation].filter((part) => part !== null && part !== '').join(', ');

function AttendeeEntry({ attendee }: { attendee: Attendee }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {attendee.personId === null ? (
          <span className="font-medium">{attendee.name}</span>
        ) : (
          <TextLink
            href={`/ontology?person=${encodeURIComponent(attendee.personId)}`}
            tone="foreground"
          >
            {attendee.name}
          </TextLink>
        )}
        {attendee.unknown ? (
          <Badge tone="peach" size="xs">
            Unknown attendee
          </Badge>
        ) : null}
      </div>
      {roleLine(attendee) === '' ? null : (
        <p className="text-xs text-muted-foreground">{roleLine(attendee)}</p>
      )}
      {attendee.unknown ? (
        <p className="text-xs text-muted-foreground">
          {attendee.email === null ? null : <span className="font-mono">{attendee.email}</span>}, no
          prior contact. <TextLink href="/ontology">Add to Ontology</TextLink>
        </p>
      ) : (
        <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground marker:text-muted-foreground">
          {attendee.interactions.map((interaction) => (
            <li key={`${interaction.provenance.recordId}-${interaction.at}`}>
              {interactionLabel(interaction)}: {interaction.summary}{' '}
              <ProvenanceLink source={interaction.provenance} seen={false} className="text-xs" />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MeetingArticle({ meeting, now, next }: { meeting: Meeting; now: Date; next: boolean }) {
  const prep = meetingVisibility(isPrepExpanded(meeting, now), next);
  const summary = invertVisibility(prep);
  const started = now.getTime() >= new Date(meeting.start).getTime();
  const done = now.getTime() >= new Date(meeting.end).getTime();

  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={titleClass(prep)}>{meeting.title}</h3>
            <Badge tone={meeting.audience === 'external' ? 'blue' : 'neutral-strong'} size="sm">
              {audienceLabel(meeting.audience, meeting.counterpartyClass)}
            </Badge>
            {done ? (
              <Badge tone="neutral" size="sm">
                Done
              </Badge>
            ) : null}
            {started && !done ? (
              <Badge tone="peach" size="sm">
                Now
              </Badge>
            ) : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            <span>
              {formatTime(meeting.start)} to {formatTime(meeting.end)}
            </span>
            {meeting.location === null ? null : (
              <>
                <span aria-hidden>·</span>
                <span>{meeting.location}</span>
              </>
            )}
            {summaryParts(meeting).map((part) => (
              <span key={part} className={INLINE_CLASS[summary]}>
                <span aria-hidden>·</span> {part}
              </span>
            ))}
            <span aria-hidden>·</span>
            <ProvenanceLink source={meeting.provenance} seen={false} />
          </p>
        </div>
        <p className={cn('text-xs text-muted-foreground', TEXT_CLASS[prep])}>
          Prep expanded {formatTime(meeting.prepExpandsAt)}
        </p>
        <p className={cn('text-xs text-muted-foreground', TEXT_CLASS[summary])}>
          {relativeTo(meeting.start, now)}
        </p>
      </div>

      <div className={cn('gap-6 lg:grid-cols-2', BLOCK_CLASS[prep])}>
        <div className="flex flex-col gap-3">
          <GroupHeading>Attendees</GroupHeading>
          {meeting.attendees.length === 0 ? (
            <p className="text-xs text-muted-foreground">The invitation lists nobody else.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {meeting.attendees.map((attendee) => (
                <AttendeeEntry key={attendeeKey(attendee)} attendee={attendee} />
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <GroupHeading>Open commitments</GroupHeading>
            {meeting.commitments.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing open with these people.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {meeting.commitments.map((commitment) => {
                  const ageing = commitmentAgeing(commitment.dueAt, commitment.overdueDays);
                  return (
                    <li key={commitment.commitmentId} className="flex flex-wrap items-center gap-2">
                      <Badge tone={commitment.direction === 'outbound' ? 'red' : 'blue'} size="xs">
                        {commitment.direction === 'outbound' ? 'You owe' : 'Owed to you'}
                      </Badge>
                      <TextLink href="/commitments" tone="foreground" className="text-sm">
                        {commitment.description}
                      </TextLink>
                      <Ageing label={ageing.label} emphasis={ageing.emphasis} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <GroupHeading>Documents and transcripts</GroupHeading>
            {meeting.documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing referenced in the last 30 days.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {meeting.documents.map((document) => (
                  <li key={`${document.source}-${document.title}`}>
                    {document.url === null ? (
                      <span>{document.title}</span>
                    ) : (
                      <TextLink href={document.url} tone="foreground">
                        {document.title}
                      </TextLink>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {' '}
                      · {document.source}
                      {document.editedAt === null
                        ? ''
                        : `, edited ${formatDayMonth(document.editedAt)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {meeting.objectives.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <GroupHeading>Suggested objectives</GroupHeading>
              <ol className="ml-4 list-decimal space-y-1 text-sm">
                {meeting.objectives.map((objective) => (
                  <li key={objective}>{objective}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/** Spec 10.1 item 2: today's meetings in order, each with its prep. */
export function MeetingsSection({ meetings, now }: { meetings: Meeting[]; now: Date }) {
  const next = nextMeetingId(meetings, now);
  return (
    <SectionCard
      title="Meetings"
      note="External meetings expand to the full prep 30 minutes before they start"
    >
      {meetings.length === 0 ? (
        <EmptyState className="px-0 py-6">Nothing in the calendar today.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {meetings.map((meeting) => (
            <MeetingArticle
              key={meeting.id}
              meeting={meeting}
              now={now}
              next={meeting.id === next}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
