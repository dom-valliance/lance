import type { ReactNode } from 'react';
import { cn } from 'cn';
import { TONE_DOT_CLASS, type Tone } from '@/lib/tones';

export interface TimelineItem {
  key: string;
  tone: Tone;
  /** The event kind, printed beside the dot so colour is never the only signal. */
  title: ReactNode;
  /** Time, actor, system: baseline-aligned after the title. */
  meta?: ReactNode;
  body?: ReactNode;
}

/**
 * A vertical trail, oldest first: a coloured dot per event joined by a
 * hairline (design foundations, section 8). Used for a proposal's status
 * history and for a correlation id's trail.
 */
export function Timeline({
  items,
  label,
  className,
}: {
  items: TimelineItem[];
  label: string;
  className?: string;
}) {
  const last = items.length - 1;
  return (
    <ol aria-label={label} className={cn('flex flex-col', className)}>
      {items.map((item, index) => (
        <li key={item.key} className="grid grid-cols-[20px_1fr] gap-3">
          <div className="flex flex-col items-center">
            <span
              aria-hidden
              className={cn('mt-[5px] size-2.5 shrink-0 rounded-full', TONE_DOT_CLASS[item.tone])}
            />
            {index < last ? <span aria-hidden className="mt-1 w-px flex-1 bg-border" /> : null}
          </div>
          <div className={cn('min-w-0', index < last && 'pb-4')}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium">{item.title}</span>
              {item.meta}
            </div>
            {item.body === undefined ? null : (
              <div className="mt-1 text-[13px] text-muted-foreground">{item.body}</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
