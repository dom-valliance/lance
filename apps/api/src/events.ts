import { z } from 'zod';

/**
 * The live-update feed behind `GET /events` (spec 12: "SSE from api for
 * live proposal and alert updates"). The feed itself is a plain fan-out
 * with no transport in it, so the routes stream it and the tests assert on
 * it without a socket.
 */

export const FeedEventSchema = z.object({
  type: z.enum(['proposal', 'alert', 'ledger']),
  id: z.string().min(1),
});
export type FeedEvent = z.infer<typeof FeedEventSchema>;

export type FeedListener = (event: FeedEvent) => void;

export interface Feed {
  /** Delivers `event` to every current subscriber. */
  notify(event: FeedEvent): void;
  /** Registers a subscriber. Returns the function that removes it. */
  subscribe(listener: FeedListener): () => void;
  /** How many subscribers are connected. */
  readonly size: number;
}

/**
 * One listener per connected client. A listener that throws is dropped
 * rather than allowed to stop delivery to the rest: a broken socket must
 * not silence the others.
 */
export function createFeed(onListenerError?: (error: unknown) => void): Feed {
  const listeners = new Set<FeedListener>();

  return {
    notify(event: FeedEvent): void {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          listeners.delete(listener);
          onListenerError?.(error);
        }
      }
    },
    subscribe(listener: FeedListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get size(): number {
      return listeners.size;
    },
  };
}
