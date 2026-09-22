import type { HistoryPage, SlackMessage } from '@lance/connectors';
import type { Observation, PollResult, SourceRecord } from '../types.js';

/**
 * The `slack-channel` partition of the `agent-logs` watcher (spec 7.1):
 * the history of the `dom-claude-agent` channel, where the inbox agent
 * posts its digests and its watermark lines.
 *
 * Reads only, and no model call: whether a line is a watermark, and what
 * time it carries, is decided from the text alone.
 */

export const SLACK_PARTITION = 'slack-channel';

/** The one other agent the spec covers in v1 alongside Lance and the webhook (spec 16 Q2). */
export const INBOX_AGENT = 'inbox-agent';

/**
 * A watermark line is any message that says how far the inbox agent has
 * read. The wording is the inbox agent's, not Lance's, so the pattern is an
 * option: change it here and in the watcher's options together.
 */
export const DEFAULT_WATERMARK_PATTERN = /watermark|processed up to|last processed/i;

/**
 * Slack returns up to 200 messages a page. Twenty pages is 4,000 messages
 * in one five minute window, which the channel cannot produce; reaching the
 * cap means the cursor is wrong, so the poll fails and the runner counts it
 * towards the partition's breaker.
 */
export const MAX_HISTORY_PAGES = 20;

const HISTORY_PAGE_LIMIT = 200;
const MAX_SUMMARY_CHARS = 160;

/** The slice of `slackReads` this partition needs, so a test can supply a double. */
export interface SlackHistoryReads {
  conversationsHistory(input: {
    channel: string;
    oldest?: string;
    cursor?: string;
    limit?: number;
  }): Promise<HistoryPage>;
}

export interface SlackChannelOptions {
  channelId: string;
  /** Lance's own bot user id (`U…`). Its messages are Lance talking, not an agent log. */
  ownBotUserId?: string;
  /** Lance's own `bot_id` (`B…`), which a message posted by the app carries instead of a user. */
  ownBotId?: string;
  watermarkPattern?: RegExp;
}

/** The canonical record for one channel message. Its hash is the third part of the idempotency key. */
export type SlackAgentLogRecord = {
  kind: 'agent_log';
  stream: 'slack';
  agent: string;
  text: string;
  ts: string;
  user: string | null;
  isWatermark: boolean;
  watermarkAt: string | null;
};

/** What `poll` hands `normalise`: the message and the channel it was read from. */
export interface SlackRawMessage {
  channel: string;
  message: SlackMessage;
}

/** Slack timestamps are seconds with a microsecond fraction, as a string. */
export function slackTsToIso(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    throw new Error(
      `agent-logs could not read the Slack timestamp "${ts}". Slack sends seconds with a fraction, for example 1758531600.000200.`,
    );
  }
  return new Date(seconds * 1000).toISOString();
}

/** Where the message is read in Slack, for provenance (non-negotiable 5). */
export function slackMessageUrl(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

const DATE_TIME =
  /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?/;
const DATE_ONLY = /(\d{4}-\d{2}-\d{2})/;

/**
 * The instant a watermark line carries, as an ISO string, or null when it
 * carries none. A line without a zone is read as UTC: the inbox agent logs
 * in UTC, and guessing Europe/London for a bare local time would move the
 * watermark by an hour for half the year.
 */
export function parseWatermarkAt(text: string): string | null {
  const full = DATE_TIME.exec(text);
  if (full !== null) {
    const [, date, time, zone] = full;
    const ms = Date.parse(`${date ?? ''}T${time ?? ''}${zone ?? 'Z'}`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly !== null) {
    const ms = Date.parse(`${dateOnly[1] ?? ''}T00:00:00Z`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/** True when the message was posted by Lance itself rather than by another agent. */
export function isOwnMessage(message: SlackMessage, options: SlackChannelOptions): boolean {
  if (options.ownBotUserId !== undefined && message.user === options.ownBotUserId) return true;
  return (
    options.ownBotId !== undefined &&
    message.bot_id !== undefined &&
    message.bot_id === options.ownBotId
  );
}

function newestTs(messages: readonly SlackMessage[], fallback: string | null): string | null {
  let newest: number | null = null;
  let newestRaw: string | null = null;
  for (const message of messages) {
    const value = Number(message.ts);
    if (!Number.isFinite(value)) continue;
    if (newest === null || value > newest) {
      newest = value;
      newestRaw = message.ts;
    }
  }
  return newestRaw ?? fallback;
}

/**
 * One poll of the channel. The cursor is the Slack ts of the newest message
 * already recorded, which `oldest` treats as exclusive, so a re-run over the
 * same window reads nothing. Lance's own messages are dropped before the
 * cursor is worked out, but they still move it: the watcher has seen them,
 * it simply has nothing to log about them.
 */
export async function pollSlackChannel(
  reads: SlackHistoryReads,
  options: SlackChannelOptions,
  cursor: string | null,
): Promise<PollResult> {
  const messages: SlackMessage[] = [];
  let pageCursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await reads.conversationsHistory({
      channel: options.channelId,
      limit: HISTORY_PAGE_LIMIT,
      ...(cursor === null ? {} : { oldest: cursor }),
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
    });
    messages.push(...page.messages);
    pages += 1;
    if (page.nextCursor === null) break;
    if (pages >= MAX_HISTORY_PAGES) {
      throw new Error(
        `agent-logs ${SLACK_PARTITION} poll reached the ${String(MAX_HISTORY_PAGES)} page cap with more history waiting. ` +
          'Check the cursor in the cursors table for channel ' +
          `${options.channelId}, or raise MAX_HISTORY_PAGES in apps/worker/src/watchers/agent-logs/slack.ts.`,
      );
    }
    pageCursor = page.nextCursor;
  }

  const records: SourceRecord[] = messages
    .filter((message) => !isOwnMessage(message, options))
    .map((message) => ({
      id: `${options.channelId}:${message.ts}`,
      observedAt: slackTsToIso(message.ts),
      raw: { channel: options.channelId, message } satisfies SlackRawMessage,
    }));

  return { records, nextCursor: newestTs(messages, cursor) };
}

function rawOf(raw: unknown): SlackRawMessage {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { channel?: unknown }).channel !== 'string' ||
    typeof (raw as { message?: unknown }).message !== 'object'
  ) {
    throw new Error(
      'agent-logs slack-channel could not read a message: the record carries no channel and message pair. ' +
        'It is built by pollSlackChannel in apps/worker/src/watchers/agent-logs/slack.ts.',
    );
  }
  return raw as SlackRawMessage;
}

/** Reduces one channel message to its canonical record and the ledger metadata around it. */
export function normaliseSlackMessage(
  record: SourceRecord,
  watermarkPattern: RegExp = DEFAULT_WATERMARK_PATTERN,
): Observation {
  const { channel, message } = rawOf(record.raw);
  const text = message.text ?? '';
  const isWatermark = watermarkPattern.test(text);
  const canonical: SlackAgentLogRecord = {
    kind: 'agent_log',
    stream: 'slack',
    agent: INBOX_AGENT,
    text,
    ts: message.ts,
    user: message.user ?? message.bot_id ?? null,
    isWatermark,
    watermarkAt: isWatermark ? parseWatermarkAt(text) : null,
  };

  return {
    sourceSystem: 'slack',
    recordId: `${channel}:${message.ts}`,
    observedAt: record.observedAt,
    record: canonical,
    correlationKey: message.ts,
    summary: text.slice(0, MAX_SUMMARY_CHARS),
    labels: ['AgentLog', 'InboxAgent', ...(isWatermark ? ['Watermark'] : [])],
    url: slackMessageUrl(channel, message.ts),
  };
}
