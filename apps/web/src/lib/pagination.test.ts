import { describe, expect, it } from 'vitest';
import { cursorFrom, pageLinks, pageSummary, positionFrom } from './pagination';

const CURSOR = '01J8Q4M7X2KD9ZABCDEFGHJKMN';

describe('cursorFrom', () => {
  it('reads a row id cursor from the cursor param', () => {
    expect(cursorFrom({ cursor: CURSOR })).toBe(CURSOR);
  });

  it('drops a value that is not a row id', () => {
    expect(cursorFrom({ cursor: 'latest' })).toBeUndefined();
    expect(cursorFrom({ cursor: '2026-09-21T09:00:00.000Z' })).toBeUndefined();
    expect(cursorFrom({ cursor: '' })).toBeUndefined();
    expect(cursorFrom({})).toBeUndefined();
  });

  it('takes the first value when the param is repeated', () => {
    expect(cursorFrom({ cursor: [CURSOR, 'later'] })).toBe(CURSOR);
  });
});

describe('positionFrom', () => {
  it('reads the position a later page carries', () => {
    expect(positionFrom({ cursor: CURSOR, start: '51' })).toBe(51);
  });

  it('starts at 1 on the first page, whatever start says', () => {
    expect(positionFrom({ start: '51' })).toBe(1);
  });

  it('starts at 1 when a later page carries no position', () => {
    expect(positionFrom({ cursor: CURSOR })).toBe(1);
  });

  it('treats a position that is not a positive whole number as 1', () => {
    expect(positionFrom({ cursor: CURSOR, start: '0' })).toBe(1);
    expect(positionFrom({ cursor: CURSOR, start: '-5' })).toBe(1);
    expect(positionFrom({ cursor: CURSOR, start: '2.5' })).toBe(1);
    expect(positionFrom({ cursor: CURSOR, start: 'ten' })).toBe(1);
    expect(positionFrom({ cursor: CURSOR, start: '99999999999999999999' })).toBe(1);
  });

  it('ignores the ledger date filter that shares the from name', () => {
    expect(positionFrom({ cursor: CURSOR, from: '2026-09-01' })).toBe(1);
  });
});

describe('pageLinks', () => {
  it('carries the filters in force on to the next page', () => {
    const links = pageLinks({
      path: '/proposals',
      params: { status: 'pending', system: 'graph' },
      keep: ['status', 'actionClass', 'system'],
      nextCursor: CURSOR,
      shown: 25,
    });

    expect(links.next).toBe(`/proposals?status=pending&system=graph&cursor=${CURSOR}&start=26`);
  });

  it('offers no next page when the api reported no cursor', () => {
    const links = pageLinks({
      path: '/alerts',
      params: {},
      keep: ['status', 'severity'],
      nextCursor: null,
      shown: 9,
    });

    expect(links.next).toBeNull();
  });

  it('offers no way back while the first page is the one being shown', () => {
    const links = pageLinks({
      path: '/tasks',
      params: { source: 'notion' },
      keep: ['source', 'status'],
      nextCursor: CURSOR,
      shown: 50,
    });

    expect(links.first).toBeNull();
  });

  it('links back to the unpaged list once a cursor is in force', () => {
    const links = pageLinks({
      path: '/tasks',
      params: { source: 'notion', cursor: CURSOR, start: '51' },
      keep: ['source', 'status'],
      nextCursor: null,
      shown: 9,
    });

    expect(links.first).toBe('/tasks?source=notion');
  });

  it('leaves the path bare when no filter is in force', () => {
    const links = pageLinks({
      path: '/alerts',
      params: { cursor: CURSOR },
      keep: ['status', 'severity'],
      nextCursor: null,
      shown: 9,
    });

    expect(links.first).toBe('/alerts');
  });

  it('ignores a cursor the page would not send to the api', () => {
    const links = pageLinks({
      path: '/proposals',
      params: { cursor: 'latest' },
      keep: ['status'],
      nextCursor: null,
      shown: 0,
    });

    expect(links.first).toBeNull();
  });

  it('adds the rows shown to the position this page carries', () => {
    const links = pageLinks({
      path: '/commitments',
      params: { cursor: CURSOR, start: '51' },
      keep: ['direction', 'status'],
      nextCursor: CURSOR,
      shown: 50,
    });

    expect(links.next).toBe(`/commitments?cursor=${CURSOR}&start=101`);
  });

  it('counts from 1 when this page carries an invalid position', () => {
    const links = pageLinks({
      path: '/alerts',
      params: { cursor: CURSOR, start: 'nonsense' },
      keep: ['status'],
      nextCursor: CURSOR,
      shown: 50,
    });

    expect(links.next).toBe(`/alerts?cursor=${CURSOR}&start=51`);
  });

  it('keeps the ledger from and to date filters beside the cursor and the position', () => {
    const links = pageLinks({
      path: '/ledger',
      params: {
        kind: 'decided',
        from: '2026-09-01',
        to: '2026-09-21',
        cursor: CURSOR,
        start: '51',
      },
      keep: ['kind', 'actor', 'sourceSystem', 'from', 'to'],
      nextCursor: CURSOR,
      shown: 50,
    });

    expect(links.next).toBe(
      `/ledger?kind=decided&from=2026-09-01&to=2026-09-21&cursor=${CURSOR}&start=101`,
    );
    expect(links.first).toBe('/ledger?kind=decided&from=2026-09-01&to=2026-09-21');
  });
});

describe('pageSummary', () => {
  it('places the first page within the total', () => {
    expect(pageSummary({ from: 1, shown: 50, total: 109 })).toBe('Showing 1 to 50 of 109');
  });

  it('places the last page within the total', () => {
    expect(pageSummary({ from: 101, shown: 9, total: 109 })).toBe('Showing 101 to 109 of 109');
  });

  it('places a single short page', () => {
    expect(pageSummary({ from: 1, shown: 9, total: 9 })).toBe('Showing 1 to 9 of 9');
  });

  it('says there is nothing to show for an empty page', () => {
    expect(pageSummary({ from: 1, shown: 0, total: 0 })).toBe('Nothing to show');
  });

  it('separates thousands', () => {
    expect(pageSummary({ from: 51, shown: 50, total: 36712 })).toBe('Showing 51 to 100 of 36,712');
    expect(pageSummary({ from: 1201, shown: 50, total: 36712 })).toBe(
      'Showing 1,201 to 1,250 of 36,712',
    );
  });

  it('never lets the last row outrun the total', () => {
    expect(pageSummary({ from: 51, shown: 50, total: 90 })).toBe('Showing 51 to 100 of 100');
  });

  it('names the filters in force after the position', () => {
    expect(pageSummary({ from: 1, shown: 3, total: 3, filterNames: ['Pending', 'Graph'] })).toBe(
      'Showing 1 to 3 of 3, filtered by Pending, Graph',
    );
  });

  it('names the filters in force after an empty page', () => {
    expect(pageSummary({ from: 1, shown: 0, total: 0, filterNames: ['Rejected'] })).toBe(
      'Nothing to show, filtered by Rejected',
    );
  });
});
