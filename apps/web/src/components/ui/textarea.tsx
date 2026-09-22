import * as React from 'react';
import { cn } from 'cn';
import { controlClass } from '@/components/ui/input';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlClass, 'h-auto min-h-[72px] resize-y py-2 leading-normal', className)}
      {...props}
    />
  );
}

export { Textarea };
