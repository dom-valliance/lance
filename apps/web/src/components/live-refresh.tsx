'use client';

import { useRouter } from 'next/navigation';
import { useServerEvents } from '@/lib/sse';

/**
 * The one client island on the proposal pages. It holds the Server-Sent
 * Events connection open and asks Next to re-render the server components
 * whenever a proposal changes, so a decision taken in Slack shows here
 * without a reload. It renders nothing.
 */
export function LiveRefresh({ streamUrl, watch }: { streamUrl: string; watch: string }) {
  const router = useRouter();

  useServerEvents(streamUrl, (message) => {
    const parsed: unknown = JSON.parse(message.data);
    const kind =
      typeof parsed === 'object' && parsed !== null && 'type' in parsed ? parsed.type : undefined;
    if (kind === watch) {
      router.refresh();
    }
  });

  return null;
}
