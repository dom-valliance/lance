import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrief, fakeDeps, type FakeDeps } from '../test-fakes.js';
import { getBrief, latestBrief, listBriefs } from './service.js';

/** The Today page's reads over the fake brief store. */

const MORNING = '2026-09-22T05:30:00.000Z';

let harness: FakeDeps;

beforeEach(() => {
  // 09:00 on 22 September 2026 in Europe/London, which is BST.
  harness = fakeDeps({ now: () => '2026-09-22T08:00:00.000Z' });
  harness.briefs.rows = [
    fakeBrief({
      id: '01K5S9V6QW3SWCCPVB0N0E305A',
      generatedAt: MORNING,
      content: { date: '2026-09-22', slackTs: '1758351600.000100' },
    }),
  ];
});

describe('latestBrief', () => {
  it('asks for the local day in the configured zone when given no date', async () => {
    await latestBrief(harness.deps, { kind: 'morning_brief' });

    expect(harness.briefs.latestQueries[0]?.from.toISOString()).toBe('2026-09-21T23:00:00.000Z');
    expect(harness.briefs.latestQueries[0]?.to.toISOString()).toBe('2026-09-22T23:00:00.000Z');
  });

  it('asks for the local day it was given', async () => {
    await latestBrief(harness.deps, { kind: 'morning_brief', date: '2026-01-15' });

    expect(harness.briefs.latestQueries[0]?.from.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(harness.briefs.latestQueries[0]?.to.toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });

  it('returns the brief with its content as stored and its Slack timestamp', async () => {
    const brief = await latestBrief(harness.deps, { kind: 'morning_brief' });

    expect(brief?.id).toBe('01K5S9V6QW3SWCCPVB0N0E305A');
    expect(brief?.content).toEqual({ date: '2026-09-22', slackTs: '1758351600.000100' });
    expect(brief?.slackTs).toBe('1758351600.000100');
  });

  it('returns nothing when that day has no brief of that kind', async () => {
    expect(await latestBrief(harness.deps, { kind: 'weekly_review' })).toBeNull();
    expect(
      await latestBrief(harness.deps, { kind: 'morning_brief', date: '2026-09-21' }),
    ).toBeNull();
  });
});

describe('listBriefs', () => {
  beforeEach(() => {
    harness.briefs.rows = [
      fakeBrief({ id: '01K5S9V6QW3SWCCPVB0N0E305A' }),
      fakeBrief({ id: '01K5S9V6QW3SWCCPVB0N0E305B', kind: 'afternoon_board' }),
      fakeBrief({ id: '01K5S9V6QW3SWCCPVB0N0E305C' }),
    ];
  });

  it('returns a page newest first and the cursor for the next one', async () => {
    const page = await listBriefs(harness.deps, { limit: 2 });

    expect(page.items.map((item) => item.id)).toEqual([
      '01K5S9V6QW3SWCCPVB0N0E305C',
      '01K5S9V6QW3SWCCPVB0N0E305B',
    ]);
    expect(page.nextCursor).toBe('01K5S9V6QW3SWCCPVB0N0E305B');
  });

  it('returns no cursor when the last page has been read', async () => {
    const page = await listBriefs(harness.deps, {});

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('filters by kind', async () => {
    const page = await listBriefs(harness.deps, { kind: 'afternoon_board' });

    expect(page.items.map((item) => item.id)).toEqual(['01K5S9V6QW3SWCCPVB0N0E305B']);
  });
});

describe('getBrief', () => {
  it('returns the brief the page asked for', async () => {
    const brief = await getBrief(harness.deps, '01K5S9V6QW3SWCCPVB0N0E305A');

    expect(brief?.markdown).toBe('# Morning brief');
  });

  it('returns nothing for an id that has no brief', async () => {
    expect(await getBrief(harness.deps, '01K5S9V6QW3SWCCPVB0N0E305Z')).toBeNull();
  });
});
