import type { ReactNode } from 'react';
import { MobileNav } from '@/components/shell/mobile-nav';
import { PausedBanner } from '@/components/shell/paused-banner';
import { Sidebar } from '@/components/shell/sidebar';
import type { ShellData } from '@/lib/shell-data';

/**
 * Sidebar at 1024 and up, top bar and drawer beneath; the paused banner
 * above every page while the kill switch is on; 32px of padding around
 * the page at desktop, 16px on a phone. Signed out, none of that has a
 * reading, so the shell steps back to a centred canvas for the sign-in
 * card (design 7.12).
 */
export function AppShell({
  agentName,
  data,
  signOut,
  children,
}: {
  agentName: string;
  data: ShellData;
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  if (!data.signedIn) {
    return <main className="grid min-h-screen place-items-center p-4">{children}</main>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        agentName={agentName}
        counts={data.counts}
        status={data.statusLine}
        signOut={signOut}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav counts={data.counts} status={data.statusLine} signOut={signOut} />
        <main className="flex flex-1 flex-col gap-6 p-4 lg:p-8">
          {data.paused === null ? null : <PausedBanner {...data.paused} />}
          {children}
        </main>
      </div>
    </div>
  );
}
