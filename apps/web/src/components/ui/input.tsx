import * as React from 'react';
import { cn } from 'cn';

/** The one class every field shares: 36px, 8px radius, brand focus ring. */
export const controlClass =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-foreground/25 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(controlClass, className)} {...props} />;
}

export { Input };
