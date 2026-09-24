import type { GraphReads, JamieReads, NotionConnector } from '@lance/connectors';
import type { Db, Principal } from '@lance/db';
import { loadConfig } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { CALENDAR_WINDOW_DAYS } from '../watchers/graph/index.js';
import { JAMIE_FIRST_RUN_DAYS } from '../watchers/jamie/index.js';
import type { Watcher } from '../watchers/types.js';
import type { ConnectorBundle, GraphBundle } from './connectors.js';
import { watchersFromConnectors } from './context.js';

/**
 * What joining costs (docs/plans/multi-user.md M3): a second principal's
 * first poll uses the same backfill limits Dom's did, and the Notion and
 * agent-logs watchers, which see the shared All Tasks database and the
 * principal's own channel, feed detectors rather than the triage agent,
 * so a new principal's backlog is not a model call per record.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const second: Principal = {
  id: '01K5S9V6QW3SWCCPVB0N0E3Q7H',
  entraOid: 'oid-second',
  upn: 'second.principal@valliance.ai',
  slackUserId: 'U0SECOND',
  slackChannelId: 'G0SECOND',
  notionUserId: 'notion-second',
  foundryEmployeeId: null,
  timeZone: 'Europe/London',
  status: 'active',
  lanceRoles: ['Lance.User'],
  rolesRecordedAt: null,
  activatedAt: new Date('2026-09-28T09:00:00.000Z'),
  createdAt: new Date('2026-09-24T09:00:00.000Z'),
  updatedAt: new Date('2026-09-28T09:00:00.000Z'),
};

interface Asked {
  mail: { deltaLink?: string }[];
  calendar: { start: string; end: string; deltaLink?: string }[];
  jamie: { startDate?: string }[];
}

const buildFor = (asked: Asked): Watcher[] => {
  const graphReads = {
    deltaMessages: (options: { deltaLink?: string }) => {
      asked.mail.push(options);
      return Promise.resolve({ messages: [], removed: [], deltaLink: 'mail-delta' });
    },
    deltaCalendarView: (options: { start: string; end: string; deltaLink?: string }) => {
      asked.calendar.push(options);
      return Promise.resolve({ events: [], removed: [], deltaLink: 'calendar-delta' });
    },
  } as unknown as GraphReads;
  const jamieReads = {
    listMeetings: (args: { startDate?: string }) => {
      asked.jamie.push(args);
      return Promise.resolve({ meetings: [], nextCursor: null });
    },
    listTasks: () => Promise.resolve({ tasks: [], nextCursor: null }),
    getMeeting: () => Promise.reject(new Error('no meeting is listed')),
  } as unknown as JamieReads;
  const connectors: ConnectorBundle = {
    graph: { reads: graphReads, writers: {} as GraphBundle['writers'] },
    notion: {
      connector: {} as NotionConnector,
      writers: {} as NonNullable<ConnectorBundle['notion']>['writers'],
      principalUserId: 'notion-second',
    },
    jamie: jamieReads,
    slack: null,
    agentLogs: {
      slack: {} as NonNullable<ConnectorBundle['agentLogs']>['slack'],
      channelId: 'G0SECOND',
      ownBotUserId: 'U0LANCE',
      ownBotId: null,
      appInsights: null,
    },
    notConnected: [],
  };
  return watchersFromConnectors({
    principal: second,
    db: {} as Db,
    config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/lance' }),
    connectors,
    agent: null,
  });
};

const named = (watchers: Watcher[], name: string): Watcher => {
  const watcher = watchers.find((candidate) => candidate.name === name);
  if (watcher === undefined) throw new Error(`No ${name} watcher was built.`);
  return watcher;
};

describe("a second principal's first poll", () => {
  it('opts the Notion and agent-logs watchers out of triage, and only those', () => {
    const watchers = buildFor({ mail: [], calendar: [], jamie: [] });
    const optedOut = watchers
      .filter((watcher) => watcher.triage === false)
      .map((watcher) => watcher.name)
      .sort();
    expect(optedOut).toEqual(['agent-logs', 'notion']);
  });

  it('reads Jamie back only the first-run window, not the whole history', async () => {
    const asked: Asked = { mail: [], calendar: [], jamie: [] };
    const before = Date.now();
    await named(buildFor(asked), 'jamie').poll('meetings', null);

    const startDate = Date.parse(asked.jamie[0]?.startDate ?? '');
    expect(startDate).toBeGreaterThanOrEqual(before - JAMIE_FIRST_RUN_DAYS * DAY_MS - 1000);
    expect(startDate).toBeLessThanOrEqual(Date.now() - JAMIE_FIRST_RUN_DAYS * DAY_MS + 1000);
  });

  it('reads the calendar only within the fourteen-day window', async () => {
    const asked: Asked = { mail: [], calendar: [], jamie: [] };
    await named(buildFor(asked), 'graph-calendar').poll('calendar', null);

    const window = asked.calendar[0];
    expect(window?.deltaLink).toBeUndefined();
    expect(Date.parse(window?.end ?? '') - Date.parse(window?.start ?? '')).toBe(
      CALENDAR_WINDOW_DAYS * DAY_MS,
    );
  });

  it("starts mail from Graph's own delta, which the connector caps at its page limit", async () => {
    const asked: Asked = { mail: [], calendar: [], jamie: [] };
    await named(buildFor(asked), 'graph-mail').poll('inbox', null);
    expect(asked.mail).toHaveLength(1);
    expect(asked.mail[0]?.deltaLink).toBeUndefined();
  });
});
