import { describe, expect, it } from 'vitest';
import type { BriefRecord } from './store.js';
import { slackTsOf, toBriefView } from './view.js';

const record = (overrides: Partial<BriefRecord> = {}): BriefRecord => ({
  id: '01K5S9V6QW3SWCCPVB0N0E305A',
  kind: 'morning_brief',
  correlationId: '01K5S9V6QW3SWCCPVB0N0E305B',
  content: { date: '2026-09-22', slackTs: '1758351600.000100' },
  markdown: '# Morning brief',
  generatedAt: '2026-09-22T05:30:00.000Z',
  ...overrides,
});

describe('slackTsOf', () => {
  it('reads the Slack timestamp the worker folded into the content', () => {
    expect(slackTsOf({ slackTs: '1758351600.000100' })).toBe('1758351600.000100');
  });

  it('reads no timestamp from a brief that was never posted', () => {
    expect(slackTsOf({ slackTs: null })).toBeNull();
    expect(slackTsOf({})).toBeNull();
  });

  it('reads no timestamp from content that is not an object', () => {
    expect(slackTsOf(null)).toBeNull();
    expect(slackTsOf('a brief')).toBeNull();
    expect(slackTsOf([{ slackTs: '1758351600.000100' }])).toBeNull();
  });
});

describe('toBriefView', () => {
  it('hands the stored content on as it was written', () => {
    const content = { eventId: 'AAMk1', section: { subject: 'The pilot' }, slackTs: '1.1' };

    expect(toBriefView(record({ kind: 'meeting_prep', content })).content).toEqual(content);
  });

  it('lifts the Slack timestamp out of the content so the page can link to the thread', () => {
    expect(toBriefView(record()).slackTs).toBe('1758351600.000100');
  });

  it('carries the id, kind, correlation id, markdown and generation time', () => {
    expect(toBriefView(record())).toMatchObject({
      id: '01K5S9V6QW3SWCCPVB0N0E305A',
      kind: 'morning_brief',
      correlationId: '01K5S9V6QW3SWCCPVB0N0E305B',
      markdown: '# Morning brief',
      generatedAt: '2026-09-22T05:30:00.000Z',
    });
  });
});
