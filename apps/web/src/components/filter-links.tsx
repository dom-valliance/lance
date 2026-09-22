import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A row of links that each select one value of a filter (spec 12: the
 * Tasks page's source and status filters, and the Commitments page's
 * direction tabs and status filter). Every option is a real link with its
 * own URL, so the current filter is shareable, bookmarkable and works
 * without JavaScript; the active one is styled as pressed.
 */
export function FilterLinks({
  label,
  options,
}: {
  label: string;
  options: { label: string; href: string; active: boolean }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((option) => (
          <Button
            key={option.href}
            asChild
            size="sm"
            variant={option.active ? 'default' : 'ghost'}
            aria-current={option.active ? 'true' : undefined}
          >
            <Link href={option.href} className={cn(option.active && 'pointer-events-none')}>
              {option.label}
            </Link>
          </Button>
        ))}
      </div>
    </div>
  );
}
