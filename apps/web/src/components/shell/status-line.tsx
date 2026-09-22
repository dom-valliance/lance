import { cn } from 'cn';
import { TONE_DOT_CLASS } from '@/lib/tones';
import type { ShellStatusLine } from '@/lib/shell-status';

export function StatusLine({ line, className }: { line: ShellStatusLine | null; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 px-3 text-xs text-muted-foreground', className)}>
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', line === null ? 'bg-muted-foreground' : TONE_DOT_CLASS[line.tone])}
      />
      {line === null ? 'Status unavailable' : line.text}
    </div>
  );
}
