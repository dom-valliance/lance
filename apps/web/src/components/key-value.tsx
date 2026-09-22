import type { ReactNode } from 'react';
import { cn } from 'cn';

/** Two columns of label-over-value pairs (design foundations, section 8). */
export function KeyValueGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('grid gap-4 sm:grid-cols-2', className)}>{children}</dl>;
}

export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}
