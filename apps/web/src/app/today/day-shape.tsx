import type { ReactNode } from 'react';
import { cn } from 'cn';
import { TextLink } from '@/components/text-link';
import {
  DAY_BAR_TICKS,
  dayBar,
  formatHours,
  meetingLoadLabel,
  type DayShape,
  type Meeting,
} from '@/lib/brief-view';
import { formatTime } from '@/lib/time';
import { SectionCard } from './section-card';

/** One of the four numbers the day opens with. */
function Stat({ label, value, meta }: { label: string; value: ReactNode; meta?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
      {meta === undefined ? null : (
        <dd className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</dd>
      )}
    </div>
  );
}

/**
 * Spec 10.1 item 1: first and last meeting, meeting load, longest free
 * block, and the 09:00 to 17:00 bar that shows where the day is full. The
 * bar is a picture of the same meetings the section below lists, so it is
 * hidden from screen readers and from the phone layout.
 */
export function DayShapeSection({
  shape,
  meetings,
  now,
}: {
  shape: DayShape;
  meetings: Meeting[];
  now: Date;
}) {
  const bar = dayBar(meetings, now);
  const free = shape.longestFreeBlock;
  return (
    <SectionCard title="Day shape" note={`Calendar seen ${formatTime(shape.calendarObservedAt)}`}>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="First meeting"
          value={shape.firstMeeting === null ? 'None' : formatTime(shape.firstMeeting.start)}
          {...(shape.firstMeeting === null ? {} : { meta: shape.firstMeeting.title })}
        />
        <Stat
          label="Last meeting"
          value={shape.lastMeeting === null ? 'None' : formatTime(shape.lastMeeting.start)}
          {...(shape.lastMeeting === null ? {} : { meta: shape.lastMeeting.title })}
        />
        <Stat
          label="In meetings"
          value={meetingLoadLabel(shape.meetingHours, shape.workingHours)}
        />
        <Stat
          label="Longest free block"
          value={
            free === null
              ? 'None'
              : `${formatTime(free.start)} to ${formatTime(free.end)}, ${formatHours(free.hours)}`
          }
        />
      </dl>

      <div aria-hidden className="hidden flex-col gap-2 lg:flex">
        <div className="relative h-10 overflow-hidden rounded-lg bg-muted/40">
          {bar.segments.map((segment) => (
            <div
              key={segment.id}
              title={segment.title}
              style={{
                left: `${String(segment.leftPercent)}%`,
                width: `${String(segment.widthPercent)}%`,
              }}
              className={cn(
                'absolute inset-y-0 border-l-2',
                segment.audience === 'external'
                  ? 'border-sem-blue-fg bg-sem-blue-bg'
                  : 'border-muted-foreground bg-muted',
              )}
            />
          ))}
          {bar.nowPercent === null ? null : (
            <div
              style={{ left: `${String(bar.nowPercent)}%` }}
              className="absolute inset-y-0 w-px bg-brand"
            />
          )}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          {DAY_BAR_TICKS.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground">
        {shape.note === null ? null : <>{shape.note} </>}
        <span className="text-brand">Now {formatTime(now)}</span>
      </p>

      {shape.proposedHolds.length === 0 ? null : (
        <p className="text-[13px] text-muted-foreground">
          Proposed holds:{' '}
          {shape.proposedHolds.map((hold, index) => (
            <span key={hold.proposalId}>
              {index === 0 ? null : ', '}
              <TextLink href={`/proposals/${hold.proposalId}`}>{hold.title}</TextLink>
            </span>
          ))}
        </p>
      )}
    </SectionCard>
  );
}
