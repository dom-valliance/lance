import type { HistoryPage, SlackMessage } from '@lance/connectors';
import { describe, expect, it } from 'vitest';
import { AGENT_LOGS_PARTITIONS, AGENT_LOGS_SCHEDULES, createAgentLogsWatcher } from './watcher.js';
import type { SlackAgentLogRecord } from './slack.js';

const CHANNEL = 'C0BU7P278N5';
const NOW = '2026-09-22T09:00:00.000Z';

const MESSAGE: SlackMessage = {
  type: 'message',
  ts: '1758531600.000200',
  user: 'U0INBOXAGENT',
  text: 'Watermark: processed up to 2026-09-22T07:45:00Z.',
};

function watcher(pages: HistoryPage[] = [{ messages: [MESSAGE], nextCursor: null }]) {
  return createAgentLogsWatcher({
    slack: {
      conversationsHistory: () => Promise.resolve(pages[0] ?? { messages: [], nextCursor: null }),
    },
    channelId: CHANNEL,
    ownBotUserId: 'U0LANCEBOT',
    principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
    now: () => NOW,
  });
}

describe('createAgentLogsWatcher', () => {
  it('runs every five minutes over the three streams of the spec', async () => {
    const agentLogs = watcher();
    expect(agentLogs.name).toBe('agent-logs');
    expect(agentLogs.schedules).toEqual([...AGENT_LOGS_SCHEDULES]);
    await expect(agentLogs.partitions()).resolves.toEqual([...AGENT_LOGS_PARTITIONS]);
  });

  it('records a channel message as a Slack observation', async () => {
    const agentLogs = watcher();
    const polled = await agentLogs.poll('slack-channel', null);
    const first = polled.records[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const observation = await agentLogs.normalise(first, 'slack-channel');
    expect(observation.sourceSystem).toBe('slack');
    expect((observation.record as SlackAgentLogRecord).watermarkAt).toBe(
      '2026-09-22T07:45:00.000Z',
    );
  });

  it('polls nothing for telemetry when no Application Insights client is given', async () => {
    await expect(watcher().poll('telemetry', null)).resolves.toEqual({
      records: [],
      nextCursor: null,
    });
  });

  it('polls nothing for the webhook stream, which the API already observes', async () => {
    await expect(watcher().poll('webhook', '2026-09-22T08:00:00.000Z')).resolves.toEqual({
      records: [],
      nextCursor: '2026-09-22T08:00:00.000Z',
    });
  });

  it('says which partitions exist when asked for one that does not', async () => {
    await expect(watcher().poll('mailbox', null)).rejects.toThrow(/has no partition named/);
  });
});
