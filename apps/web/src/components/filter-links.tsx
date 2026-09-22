import Link from 'next/link';
import { cn } from 'cn';

/**
 * A row of pills that each select one value of a filter (spec 12: the
 * Tasks page's source and status filters, the Commitments page's status
 * filter). Every option is a real link with its own URL, so the current
 * filter is shareable, bookmarkable and works without JavaScript; the
 * active one is the primary fill and carries aria-current. Monochrome,
 * never coloured (design foundations, section 6).
 */
export function FilterLinks({
  label,
  options,
  className,
}: {
  label: string;
  options: { label: string; href: string; active: boolean }[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {options.map((option) => (
          <Link
            key={option.href}
            href={option.href}
            aria-current={option.active ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/45 lg:h-8',
              option.active
                ? 'pointer-events-none bg-primary text-primary-foreground'
                : 'bg-muted text-foreground hover:bg-[oklch(0.33_0_0)]',
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
