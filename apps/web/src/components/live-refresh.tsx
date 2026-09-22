'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useServerEvents } from '@/lib/sse';
import { formatTime } from '@/lib/time';

/** Only a ULID or a similar plain id may reach the flash rule; anything else is ignored. */
const SAFE_ID = /^[A-Za-z0-9_:-]+$/;
const FLASH_MS = 1600;

/**
 * The one client island on a live page. It holds the Server-Sent Events
 * connection open and asks Next to re-render the server components
 * whenever a record of the watched type changes, so a decision taken in
 * Slack shows here without a reload. The row that changed (marked with
 * `data-live-id`) settles from a soft accent flash. With `indicator` it
 * also renders the "Live, updated 14:05" line.
 */
export function LiveRefresh({
  streamUrl,
  watch,
  indicator = false,
}: {
  streamUrl: string;
  watch: string;
  indicator?: boolean;
}) {
  const router = useRouter();
  const [flashId, setFlashId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useServerEvents(streamUrl, (message) => {
    const parsed: unknown = JSON.parse(message.data);
    if (typeof parsed !== 'object' || parsed === null) return;
    const kind = 'type' in parsed ? parsed.type : undefined;
    if (kind !== watch) return;
    const id = 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : null;
    setFlashId(id !== null && SAFE_ID.test(id) ? id : null);
    setUpdatedAt(new Date());
    router.refresh();
  });

  useEffect(() => {
    if (flashId === null) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  return (
    <>
      {flashId === null ? null : (
        <style>{`[data-live-id="${flashId}"]{animation:flash 1.2s ease-out 1}`}</style>
      )}
      {indicator ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-sem-green-fg" />
          {updatedAt === null ? 'Live' : `Live, updated ${formatTime(updatedAt)}`}
        </span>
      ) : null}
    </>
  );
}
