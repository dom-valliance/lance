import type { ReactNode } from 'react';
import { cn } from 'cn';

/** A labelled control: the label above in 12px muted text, an optional hint beneath. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('flex flex-col gap-1 text-xs text-muted-foreground', className)}>
      <span>{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
