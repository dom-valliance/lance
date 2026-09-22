'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from 'cn';
import { isUnder } from '@/components/shell/nav';

/**
 * One sidebar or drawer entry. The active page carries aria-current, the
 * muted fill and the brand bar at its left edge. A count sits at the end
 * of the row: the pending proposals count in the brand pill, other counts
 * as plain muted text.
 */
export function NavLink({
  href,
  label,
  count,
  emphasiseCount = false,
  tall = false,
  onNavigate,
}: {
  href: string;
  label: string;
  count?: number | null | undefined;
  emphasiseCount?: boolean;
  tall?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const pathname = usePathname();
  const active = isUnder(pathname, href);
  const showCount = typeof count === 'number' && count > 0;
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      className={cn(
        'flex items-center justify-between rounded-lg px-3 text-sm text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/45',
        tall ? 'h-11' : 'h-9',
        active && 'bg-sidebar-accent shadow-[inset_2px_0_0_var(--brand)]',
      )}
    >
      {label}
      {showCount ? (
        emphasiseCount ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-brand">
            {count}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{count}</span>
        )
      ) : null}
    </Link>
  );
}
