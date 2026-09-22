import { cn } from 'cn';
import { TriangleAlert } from 'lucide-react';

export type AgeingEmphasis = 'overdue' | 'soon' | 'none';

/**
 * The plain-words ageing label that sits beneath an absolute date
 * ("overdue by 3 days", "due today", "due in 3 days"). Overdue adds the
 * danger colour and a leading glyph so the state survives without colour;
 * "soon" (due today, expiring) takes the brand accent.
 */
export function Ageing({
  label,
  emphasis = 'none',
  className,
}: {
  label: string;
  emphasis?: AgeingEmphasis;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        emphasis === 'overdue' && 'text-sem-red-fg',
        emphasis === 'soon' && 'text-brand',
        emphasis === 'none' && 'text-muted-foreground',
        className,
      )}
    >
      {emphasis === 'overdue' ? <TriangleAlert aria-hidden className="size-3 shrink-0" /> : null}
      {label}
    </span>
  );
}
