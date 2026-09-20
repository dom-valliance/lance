import type { Metadata } from 'next';
import { AppSidebar, agentDisplayName } from '@/components/app-sidebar';
import './globals.css';

export function generateMetadata(): Metadata {
  return {
    title: agentDisplayName(),
    description: 'Personal operating agent for Dom Selvon.',
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen bg-background text-foreground">
        <AppSidebar />
        <main className="flex-1 p-8">{children}</main>
      </body>
    </html>
  );
}
