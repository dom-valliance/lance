import type { HistoryPage, SlackMessage } from '@lance/connectors';
import { hashRecord } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '../types.js';
import {
  DEFAULT_WATERMARK_PATTERN,
  normaliseSlackMessage,
  parseWatermarkAt,
  pollSlackChannel,
  slackTsToIso,
  type SlackAgentLogRecord,
  type SlackChannelOptions,
  type SlackHistoryReads,
} from './slack.js';

const CHANNEL = 'C0BU7P278N5';
const LANCE_BOT_USER = 'U0LANCEBOT';
const LANCE_BOT_ID = 'B0LANCEAPP';
const INBOX_USER = 'U0INBOXAGENT';

const OPTIONS: SlackChannelOptions = {
  channelId: CHANNEL,
  ownBotUserId: LANCE_BOT_USER,
  ownBotId: LANCE_BOT_ID,
  watermarkPattern: DEFAULT_WATERMARK_PATTERN,
};

function message(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    type: 'message',
    ts: '1758531600.000200',
    user: INBOX_USER,
    text: 'Digest: 4 mails triaged, 1 needs Dom.',
    ...overrides,
  };
}

interface HistoryCall {
  channel: string;
  oldest?: string;
  cursor?: string;
  limit?: number;
}

function fakeReads(pages: HistoryPage[]): SlackHistoryReads & { calls: HistoryCall[] } {
  const calls: HistoryCall[] = [];
  let page = 0;
  return {
    calls,
    conversationsHistory: (input) => {
      calls.push(input);
      const result = pages[Math.min(page, pages.length - 1)] ?? { messages: [], nextCursor: null };
      page += 1;
      return Promise.resolve(result);
    },
  };
}

function sourceRecord(raw: SlackMessage): SourceRecord {
  return {
    id: `${CHANNEL}:${raw.ts}`,
    observedAt: slackTsToIso(raw.ts),
    raw: { channel: CHANNEL, message: raw },
  };
}

describe('pollSlackChannel', () => {
  it('asks Slack for everything after the cursor', async () => {
    const reads = fakeReads([{ messages: [], nextCursor: null }]);
    await pollSlackChannel(reads, OPTIONS, '1758531000.000100');
    expect(reads.calls[0]).toEqual({
      channel: CHANNEL,
      limit: 200,
      oldest: '1758531000.000100',
    });
  });

  it('asks for the whole history on the first poll', async () => {
    const reads = fakeReads([{ messages: [], nextCursor: null }]);
    await pollSlackChannel(reads, OPTIONS, null);
    expect(reads.calls[0]).toEqual({ channel: CHANNEL, limit: 200 });
  });

  it('skips the messages Lance posted itself but still advances past them', async () => {
    const reads = fakeReads([
      {
        messages: [
          message({ ts: '1758531600.000200' }),
          message({ ts: '1758531700.000300', user: LANCE_BOT_USER, text: 'Proposal ready.' }),
          message({ ts: '1758531800.000400', user: undefined, bot_id: LANCE_BOT_ID, text: 'Ack.' }),
        ],
        nextCursor: null,
      },
    ]);
    const result = await pollSlackChannel(reads, OPTIONS, null);
    expect(result.records.map((record) => record.id)).toEqual([`${CHANNEL}:1758531600.000200`]);
    expect(result.nextCursor).toBe('1758531800.000400');
  });

  it('keeps the cursor where it was when the window is empty', async () => {
    const reads = fakeReads([{ messages: [], nextCursor: null }]);
    const result = await pollSlackChannel(reads, OPTIONS, '1758531000.000100');
    expect(result.nextCursor).toBe('1758531000.000100');
    expect(result.records).toEqual([]);
  });

  it('follows the page cursor to the end of the history', async () => {
    const reads = fakeReads([
      { messages: [message({ ts: '1758531600.000200' })], nextCursor: 'page-2' },
      { messages: [message({ ts: '1758531900.000500' })], nextCursor: null },
    ]);
    const result = await pollSlackChannel(reads, OPTIONS, null);
    expect(reads.calls[1]).toMatchObject({ cursor: 'page-2' });
    expect(result.records).toHaveLength(2);
    expect(result.nextCursor).toBe('1758531900.000500');
  });

  it('fails the poll when the page cap is reached, so the runner counts it', async () => {
    const reads = fakeReads([{ messages: [message()], nextCursor: 'more' }]);
    await expect(pollSlackChannel(reads, OPTIONS, null)).rejects.toThrow(/page cap/);
  });
});

describe('normaliseSlackMessage', () => {
  it('records a digest as an inbox agent log with the Slack ts as its correlation key', () => {
    const observation = normaliseSlackMessage(sourceRecord(message()));
    const record = observation.record as SlackAgentLogRecord;
    expect(record).toEqual({
      kind: 'agent_log',
      stream: 'slack',
      agent: 'inbox-agent',
      text: 'Digest: 4 mails triaged, 1 needs Dom.',
      ts: '1758531600.000200',
      user: INBOX_USER,
      isWatermark: false,
      watermarkAt: null,
    });
    expect(observation.sourceSystem).toBe('slack');
    expect(observation.correlationKey).toBe('1758531600.000200');
    expect(observation.labels).toEqual(['AgentLog', 'InboxAgent']);
    expect(observation.url).toBe('https://slack.com/archives/C0BU7P278N5/p1758531600000200');
  });

  it('labels a watermark line and parses the instant it carries', () => {
    const observation = normaliseSlackMessage(
      sourceRecord(message({ text: 'Watermark: processed up to 2026-09-22T07:45:00Z.' })),
    );
    const record = observation.record as SlackAgentLogRecord;
    expect(record.isWatermark).toBe(true);
    expect(record.watermarkAt).toBe('2026-09-22T07:45:00.000Z');
    expect(observation.labels).toEqual(['AgentLog', 'InboxAgent', 'Watermark']);
  });

  it('labels a watermark line that carries no readable instant', () => {
    const observation = normaliseSlackMessage(
      sourceRecord(message({ text: 'Last processed everything in the inbox.' })),
    );
    const record = observation.record as SlackAgentLogRecord;
    expect(record.isWatermark).toBe(true);
    expect(record.watermarkAt).toBeNull();
  });

  it('gives the same record every time the same message is normalised', () => {
    const first = normaliseSlackMessage(sourceRecord(message()));
    const second = normaliseSlackMessage(sourceRecord(message()));
    expect(second.record).toEqual(first.record);
    expect(hashRecord(second.record)).toBe(hashRecord(first.record));
  });

  it('names the bot that posted when the message carries no user', () => {
    const observation = normaliseSlackMessage(
      sourceRecord(message({ user: undefined, bot_id: 'B0INBOXAPP' })),
    );
    expect((observation.record as SlackAgentLogRecord).user).toBe('B0INBOXAPP');
  });
});

describe('parseWatermarkAt', () => {
  it('reads an instant written with a space and an offset', () => {
    expect(parseWatermarkAt('processed up to 2026-09-22 08:30:00 +01:00')).toBe(
      '2026-09-22T07:30:00.000Z',
    );
  });

  it('reads a bare date as midnight UTC', () => {
    expect(parseWatermarkAt('watermark 2026-09-21')).toBe('2026-09-21T00:00:00.000Z');
  });

  it('reads nothing from a line with no date at all', () => {
    expect(parseWatermarkAt('watermark unchanged')).toBeNull();
  });
});
