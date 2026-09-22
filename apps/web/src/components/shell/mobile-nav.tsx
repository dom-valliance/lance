'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NAV_ITEMS, pageTitleFor, type NavCounts } from '@/components/shell/nav';
import { NavLink } from '@/components/shell/nav-link';
import { StarMark } from '@/components/shell/star-mark';
import { StatusLine } from '@/components/shell/status-line';
import type { ShellStatusLine } from '@/lib/shell-status';

/**
 * Below 1024 the sidebar becomes a 56px top bar: star mark, the page
 * title, the pending count and a menu button. The menu opens a
 * full-height drawer with the same ten links, the health line and Sign
 * out; every target is 44px tall.
 */
export function MobileNav({
  counts,
  status,
  signOut,
}: {
  counts: NavCounts;
  status: ShellStatusLine | null;
  signOut: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const pending = counts.pendingProposals;

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-sidebar pr-2 pl-4 lg:hidden">
      <StarMark className="text-foreground" title="Lance" />
      <span className="flex-1 truncate font-semibold">{pageTitleFor(pathname)}</span>
      {typeof pending === 'number' && pending > 0 ? (
        <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-brand-soft px-1.5 text-xs font-semibold text-brand">
          {pending}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        aria-label={open ? 'Close menu' : 'Menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </Button>
      {open ? (
        <nav
          id="mobile-menu"
          aria-label="Pages"
          className="absolute inset-x-0 top-14 flex h-[calc(100dvh-3.5rem)] flex-col gap-0.5 overflow-y-auto border-t border-border bg-background p-2"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              tall
              count={
                item.href === '/proposals'
                  ? counts.pendingProposals
                  : item.href === '/alerts'
                    ? counts.openAlerts
                    : undefined
              }
              emphasiseCount={item.href === '/proposals'}
              onNavigate={() => setOpen(false)}
            />
          ))}
          <div className="mt-auto flex flex-col gap-3 border-t border-border px-1 pt-4 pb-2">
            <StatusLine line={status} />
            <form action={signOut}>
              <Button type="submit" variant="outline" size="lg" className="w-full">
                Sign out
              </Button>
            </form>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
