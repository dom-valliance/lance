import type { ReactNode } from 'react';
import { cn } from 'cn';

/**
 * One section of the brief. Every section is the same card: a 16px
 * semibold title on the left, a 12px muted note on the right, and the
 * section's own content beneath.
 */
export function SectionCard({
  title,
  note,
  className,
  children,
}: {
  title: ReactNode;
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-4 rounded-xl bg-card p-6', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {note === undefined ? null : <div className="text-xs text-muted-foreground">{note}</div>}
      </div>
      {children}
    </section>
  );
}

/** The 12px muted heading above a group inside a section. */
export function GroupHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

/** A coloured dot before a line, for the lists the afternoon board draws. */
export function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', className)} />;
}
