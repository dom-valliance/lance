import { Button } from '@/components/ui/button';
import { NAV_ITEMS, type NavCounts } from '@/components/shell/nav';
import { NavLink } from '@/components/shell/nav-link';
import { StatusLine } from '@/components/shell/status-line';
import { Wordmark } from '@/components/shell/wordmark';
import type { ShellStatusLine } from '@/lib/shell-status';

/**
 * The fixed 224px sidebar at 1024 and up: wordmark, the ten pages, the
 * health line and Sign out. Below 1024 the mobile top bar replaces it.
 */
export function Sidebar({
  agentName,
  counts,
  status,
  signOut,
}: {
  agentName: string;
  counts: NavCounts;
  status: ShellStatusLine | null;
  signOut: () => Promise<void>;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-5 border-r border-sidebar-border bg-sidebar px-4 py-6 lg:flex">
      <div className="flex h-[22px] items-center px-3">
        <Wordmark name={agentName} />
      </div>
      <nav aria-label="Pages" className="flex flex-1 flex-col gap-0.5">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            count={
              item.href === '/proposals'
                ? counts.pendingProposals
                : item.href === '/alerts'
                  ? counts.openAlerts
                  : undefined
            }
            emphasiseCount={item.href === '/proposals'}
          />
        ))}
      </nav>
      <div className="flex flex-col gap-3 border-t border-sidebar-border pt-4">
        <StatusLine line={status} />
        <form action={signOut}>
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  );
}
