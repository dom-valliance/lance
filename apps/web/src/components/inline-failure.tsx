import type { ReactNode } from 'react';
import { cn } from 'cn';
import { CircleAlert } from 'lucide-react';

/**
 * A failure in the design's one shape: `role="alert"`, danger text, a
 * leading glyph so the state survives without colour, placed directly
 * beneath the form or list it belongs to. Never a toast.
 */
export function InlineFailure({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn('flex items-start gap-1.5 text-[13px] text-sem-red-fg', className)}>
      <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
