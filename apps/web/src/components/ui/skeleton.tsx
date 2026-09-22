import { cn } from 'cn';

/** A grey bar that pulses where text will land. Loading is a skeleton, never a page spinner. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-3 animate-pulse rounded bg-muted', className)} />;
}

const WIDTHS = ['w-[70%]', 'w-[45%]', 'w-[60%]', 'w-[80%]', 'w-[55%]'];

/** Stacked bars inside a card, for a list or table that is still streaming. */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className={cn('flex flex-col gap-5 rounded-xl bg-card p-6', className)}
    >
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={WIDTHS[index % WIDTHS.length] ?? 'w-1/2'} />
      ))}
    </div>
  );
}
