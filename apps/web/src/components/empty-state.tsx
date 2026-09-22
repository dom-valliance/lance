import type { ReactNode } from 'react';
import { cn } from 'cn';

/**
 * One sentence plus a link, left aligned, where the table would have been.
 * No illustration (design foundations, section 7).
 */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('px-6 py-12 text-sm text-muted-foreground', className)}>{children}</p>;
}
