import Link from 'next/link';
import { signOut } from '@/auth';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

const NAV_ITEMS = [
  { href: '/today', label: 'Today' },
  { href: '/proposals', label: 'Proposals' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/commitments', label: 'Commitments' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/ontology', label: 'Ontology' },
  { href: '/policies', label: 'Policies' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/agents', label: 'Agents' },
  { href: '/settings', label: 'Settings' },
] as const;

export function agentDisplayName(): string {
  return process.env['AGENT_DISPLAY_NAME'] ?? 'Lance';
}

export function AppSidebar() {
  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-border bg-sidebar px-4 py-6">
      <span className="font-heading text-lg font-semibold text-sidebar-foreground">
        {agentDisplayName()}
      </span>
      <Separator className="my-4" />
      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Separator className="my-4" />
      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/today' });
        }}
      >
        <Button type="submit" variant="outline" className="w-full">
          Sign out
        </Button>
      </form>
    </aside>
  );
}
