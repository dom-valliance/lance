'use client';

import { useEffect, useRef } from 'react';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Subscribes to a Server-Sent Events endpoint for as long as the calling
 * component stays mounted, reconnecting with exponential backoff whenever
 * the connection drops. Not wired into any page yet: `apps/api` has no SSE
 * endpoint until a later work package lands it (see ./api.ts for the same
 * note on the tRPC `AppRouter`).
 */
export function useServerEvents(url: string, onEvent: (event: MessageEvent<string>) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect(): void {
      source = new EventSource(url);

      source.onopen = () => {
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      };

      source.onmessage = (event: MessageEvent<string>) => {
        onEventRef.current(event);
      };

      source.onerror = () => {
        source?.close();
        if (stopped) {
          return;
        }
        reconnectTimer = setTimeout(connect, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  }, [url]);
}
