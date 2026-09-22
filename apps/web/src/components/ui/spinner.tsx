import { cn } from 'cn';
import { LoaderCircle } from 'lucide-react';

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cn('size-3.5 animate-spin', className)} />;
}
