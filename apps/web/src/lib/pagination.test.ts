import { describe, expect, it } from 'vitest';
import { cursorFrom, pageLinks, shownLabel } from './pagination';

const CURSOR = '01J8Q4M7X2KD9ZABCDEFGHJKMN';

describe('cursorFrom', () => {
  it('reads a row id cursor from the cursor param', () => {
    expect(cursorFrom({ cursor: CURSOR })).toBe(CURSOR);
  });

  it('reads a timestamp cursor from the param the ledger pages by', () => {
    expect(cursorFrom({ to: '2026-09-21T09:00:00.000Z' }, 'to')).toBe('2026-09-21T09:00:00.000Z');
  });

  it('treats the ledger filter form calendar day as no cursor', () => {
    expect(cursorFrom({ to: '2026-09-21' }, 'to')).toBeUndefined();
  });

  it('drops a value that is neither a row id nor an instant', () => {
    expect(cursorFrom({ cursor: 'latest' })).toBeUndefined();
    expect(cursorFrom({ cursor: '' })).toBeUndefined();
    expect(cursorFrom({})).toBeUndefined();
  });

  it('takes the first value when the param is repeated', () => {
    expect(cursorFrom({ cursor: [CURSOR, 'later'] })).toBe(CURSOR);
  });
});

describe('pageLinks', () => {
  it('carries the filters in force on to the next page', () => {
    const links = pageLinks({
      path: '/proposals',
      params: { status: 'pending', system: 'graph' },
      keep: ['status', 'actionClass', 'system'],
      nextCursor: CURSOR,
    });

    expect(links.next).toBe(`/proposals?status=pending&system=graph&cursor=${CURSOR}`);
  });

  it('offers no next page when the api reported no cursor', () => {
    const links = pageLinks({
      path: '/alerts',
      params: {},
      keep: ['status', 'severity'],
      nextCursor: null,
    });

    expect(links.next).toBeNull();
  });

  it('offers no way back while the first page is the one being shown', () => {
    const links = pageLinks({
      path: '/tasks',
      params: { source: 'notion' },
      keep: ['source', 'status'],
      nextCursor: CURSOR,
    });

    expect(links.first).toBeNull();
  });

  it('links back to the unpaged list once a cursor is in force', () => {
    const links = pageLinks({
      path: '/tasks',
      params: { source: 'notion', cursor: CURSOR },
      keep: ['source', 'status'],
      nextCursor: null,
    });

    expect(links.first).toBe('/tasks?source=notion');
  });

  it('leaves the path bare when no filter is in force', () => {
    const links = pageLinks({
      path: '/alerts',
      params: { cursor: CURSOR },
      keep: ['status', 'severity'],
      nextCursor: null,
    });

    expect(links.first).toBe('/alerts');
  });

  it('replaces the ledger to param with the cursor rather than keeping both', () => {
    const links = pageLinks({
      path: '/ledger',
      params: { kind: 'decided', to: '2026-09-21T09:00:00.000Z' },
      keep: ['kind', 'actor', 'sourceSystem', 'from', 'to'],
      nextCursor: '2026-09-20T09:00:00.000Z',
      cursorParam: 'to',
    });

    expect(links.next).toBe('/ledger?kind=decided&to=2026-09-20T09%3A00%3A00.000Z');
    expect(links.first).toBe('/ledger?kind=decided');
  });

  it('ignores a cursor the page would not send to the api', () => {
    const links = pageLinks({
      path: '/proposals',
      params: { cursor: 'latest' },
      keep: ['status'],
      nextCursor: null,
    });

    expect(links.first).toBeNull();
  });
});

describe('shownLabel', () => {
  it('counts the rows on the page', () => {
    expect(shownLabel(25)).toBe('25 shown');
  });

  it('names the filters in force after the count', () => {
    expect(shownLabel(3, ['Pending', 'Graph'])).toBe('3 shown, filtered by Pending, Graph');
  });
});
