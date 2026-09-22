import * as React from 'react';
import { cn } from 'cn';
import { ChevronDown } from 'lucide-react';
import { controlClass } from '@/components/ui/input';

/** A native select with the design's chevron; the URL holds its state on filter forms. */
function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex w-full', className)}>
      <select data-slot="select" className={cn(controlClass, 'appearance-none pr-8')} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

export { Select };
