import { Pause } from 'lucide-react';
import { TextLink } from '@/components/text-link';
import { formatTime } from '@/lib/time';

/**
 * Shown above the page title on every page while the kill switch is on
 * (design, Settings states). Reads are still allowed; the banner says
 * what stopped and where to resume.
 */
export function PausedBanner({
  pausedAt,
  pausedBy,
  pausedReason,
}: {
  pausedAt: string | null;
  pausedBy: string | null;
  pausedReason: string | null;
}) {
  const since = pausedAt === null ? '' : ` since ${formatTime(pausedAt)}`;
  const by = pausedBy === null ? '' : pausedBy === 'user:dom' ? ' by you' : ` by ${pausedBy}`;
  const reason = pausedReason === null ? '' : `: "${pausedReason}"`;
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-sem-red-line bg-sem-red-bg px-4 py-3 text-sm text-sem-red-fg"
    >
      <Pause aria-hidden className="size-4 shrink-0" />
      <span className="flex-1">
        Lance is paused{since}
        {by}
        {reason}. Nothing is being watched or executed.
      </span>
      <TextLink href="/settings" className="font-medium">
        Resume in Settings
      </TextLink>
    </div>
  );
}
