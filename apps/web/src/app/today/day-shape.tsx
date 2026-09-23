import type { ReactNode } from 'react';
import { cn } from 'cn';
import { TextLink } from '@/components/text-link';
import {
  DAY_BAR_TICKS,
  dayBar,
  formatHours,
  freeBlockLabel,
  meetingLoadLabel,
  meetingMarkerLabel,
  type DayShape,
  type Meeting,
} from '@/lib/brief-view';
import { formatTime } from '@/lib/time';
import { SectionCard } from './section-card';

/**
 * One of the four numbers the day opens with. At desktop width it is a
 * stacked label and value in a four-column row; at phone width the same
 * markup becomes one row of a two-column list, with the shorter label and
 * the shorter value (design 7.1, 360: "the day shape becomes a list").
 */
function Stat({
  label,
  shortLabel,
  value,
  shortValue = value,
}: {
  label: string;
  shortLabel: string;
  value: ReactNode;
  shortValue?: ReactNode;
}) {
  return (
    <div className="contents lg:block">
      <dt className="text-muted-foreground lg:text-xs">
        <span className="lg:hidden">{shortLabel}</span>
        <span className="hidden lg:inline">{label}</span>
      </dt>
      <dd className="min-w-0 lg:mt-1 lg:font-medium">
        <span className="lg:hidden">{shortValue}</span>
        <span className="hidden lg:inline">{value}</span>
      </dd>
    </div>
  );
}

/**
 * Spec 10.1 item 1: first and last meeting, meeting load, longest free
 * block, and the 09:00 to 17:00 bar that shows where the day is full. Each
 * meeting is a labelled block on the bar, external ones in the blue tint
 * and internal ones in grey, with the brand line marking now. The bar is a
 * picture of the same meetings the section below lists, so it is hidden
 * from screen readers and from the phone layout.
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
  return (
    <SectionCard
      title="Day shape"
      note={`from the calendar, read ${formatTime(shape.calendarObservedAt)}`}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] lg:grid-cols-4 lg:gap-6 lg:text-sm">
        <Stat
          label="First meeting"
          shortLabel="First"
          value={meetingMarkerLabel(shape.firstMeeting)}
        />
        <Stat
          label="Last meeting"
          shortLabel="Last"
          value={meetingMarkerLabel(shape.lastMeeting)}
        />
        <Stat
          label="In meetings"
          shortLabel="In meetings"
          value={meetingLoadLabel(shape.meetingHours, shape.workingHours)}
          shortValue={formatHours(shape.meetingHours)}
        />
        <Stat
          label="Longest free block"
          shortLabel="Free block"
          value={freeBlockLabel(shape.longestFreeBlock, 'with-length')}
          shortValue={freeBlockLabel(shape.longestFreeBlock, 'times-only')}
        />
      </dl>

      <div
        aria-hidden
        className="hidden grid-cols-[52px_1fr] gap-x-3 text-xs text-muted-foreground lg:grid"
      >
        <div className="relative col-start-2 h-9 rounded-md bg-background">
          {bar.segments.map((segment) => (
            <div
              key={segment.id}
              title={segment.title}
              style={{
                left: `${String(segment.leftPercent)}%`,
                width: `${String(segment.widthPercent)}%`,
              }}
              className={cn(
                'absolute inset-y-1 overflow-hidden rounded-sm border-l-2 px-1.5 py-0.5 text-xs whitespace-nowrap text-foreground',
                segment.audience === 'external'
                  ? 'border-sem-blue-fg bg-sem-blue-bg'
                  : 'border-muted-foreground bg-muted',
              )}
            >
              {segment.title}
            </div>
          ))}
          {bar.nowPercent === null ? null : (
            <div
              style={{ left: `${String(bar.nowPercent)}%` }}
              className="absolute inset-y-0 w-px bg-brand"
            />
          )}
        </div>
        <div className="col-start-2 flex justify-between pt-1">
          {DAY_BAR_TICKS.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground">
        {shape.note === null ? null : <>{shape.note} </>}
        <span className="text-brand">Now {formatTime(now)}</span>.
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
