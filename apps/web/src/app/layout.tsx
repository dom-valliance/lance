import type { Metadata } from 'next';
import { signOutAction } from '@/app/actions';
import { AppShell } from '@/components/shell/app-shell';
import { loadShellData } from '@/lib/shell-data';
import './globals.css';

export function agentDisplayName(): string {
  return process.env['AGENT_DISPLAY_NAME'] ?? 'Lance';
}

export function generateMetadata(): Metadata {
  return {
    title: agentDisplayName(),
    description: 'Personal operating agent for Dom Selvon.',
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const data = await loadShellData();
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground">
        <AppShell agentName={agentDisplayName()} data={data} signOut={signOutAction}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
