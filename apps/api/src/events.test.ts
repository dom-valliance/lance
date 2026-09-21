import { describe, expect, it } from 'vitest';
import { createFeed, FeedEventSchema, type FeedEvent } from './events.js';

describe('the live feed', () => {
  it('delivers an event to every subscriber', () => {
    const feed = createFeed();
    const first: FeedEvent[] = [];
    const second: FeedEvent[] = [];
    feed.subscribe((event) => first.push(event));
    feed.subscribe((event) => second.push(event));

    feed.notify({ type: 'proposal', id: '01K5S9V6QW3SWCCPVB0N0E301A' });

    expect(first).toEqual([{ type: 'proposal', id: '01K5S9V6QW3SWCCPVB0N0E301A' }]);
    expect(second).toEqual(first);
  });

  it('stops delivering to a subscriber that has unsubscribed', () => {
    const feed = createFeed();
    const received: FeedEvent[] = [];
    const unsubscribe = feed.subscribe((event) => received.push(event));

    unsubscribe();
    feed.notify({ type: 'alert', id: 'a1' });

    expect(received).toEqual([]);
    expect(feed.size).toBe(0);
  });

  it('drops a subscriber that throws and keeps delivering to the rest', () => {
    const failures: unknown[] = [];
    const feed = createFeed((error) => failures.push(error));
    const received: FeedEvent[] = [];
    feed.subscribe(() => {
      throw new Error('socket closed');
    });
    feed.subscribe((event) => received.push(event));

    feed.notify({ type: 'ledger', id: 'e1' });
    feed.notify({ type: 'ledger', id: 'e2' });

    expect(received.map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(failures).toHaveLength(1);
    expect(feed.size).toBe(1);
  });
});

describe('FeedEventSchema', () => {
  it('rejects a type the UI does not know how to refresh', () => {
    expect(FeedEventSchema.safeParse({ type: 'weather', id: 'x' }).success).toBe(false);
  });
});
