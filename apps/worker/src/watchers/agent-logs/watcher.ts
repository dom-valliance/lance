import type { AppInsightsClient } from '@lance/connectors';
import { nowIso } from '@lance/shared';
import type { Observation, PollResult, Watcher } from '../types.js';
import {
  DEFAULT_WATERMARK_PATTERN,
  SLACK_PARTITION,
  normaliseSlackMessage,
  pollSlackChannel,
  type SlackChannelOptions,
  type SlackHistoryReads,
} from './slack.js';
import { TELEMETRY_PARTITION, normaliseTelemetryRow, pollTelemetry } from './telemetry.js';
import { WEBHOOK_PARTITION, pollWebhook } from './webhook.js';

/**
 * The `agent-logs` watcher (spec 7.1): three streams, one watcher.
 *
 * `slack-channel` reads the `dom-claude-agent` channel, where the inbox
 * agent posts its digests and watermark lines, and records each message
 * under source system `slack`. `telemetry` reads Lance's own failed spans
 * and skipped steps out of Application Insights under source system
 * `lance`. `webhook` reads nothing: the API's `POST /ingest/agent-log` has
 * already written those observations under source system `webhook`; see
 * `webhook.ts`.
 *
 * No model call anywhere. Every label is decided from the record.
 */

export const AGENT_LOGS_WATCHER_NAME = 'agent-logs';

/** Spec 7.1 calls this watcher continuous; five minutes is as continuous as the scheduler gets. */
export const AGENT_LOGS_SCHEDULES = ['*/5 * * * *'] as const;

export const AGENT_LOGS_PARTITIONS = [
  SLACK_PARTITION,
  TELEMETRY_PARTITION,
  WEBHOOK_PARTITION,
] as const;

export interface AgentLogsWatcherOptions {
  /** The channel history read from `@lance/connectors`. */
  slack: SlackHistoryReads;
  /** The principal's own channel (ADR 0023); `dom-claude-agent` for Dom. */
  channelId: string;
  /** Lance's own Slack bot user id, so its own messages are not logged as another agent's. */
  ownBotUserId?: string;
  /** Lance's own `bot_id`, which a message posted by the app carries in place of a user. */
  ownBotId?: string;
  /** Defaults to `DEFAULT_WATERMARK_PATTERN`. Must not carry the global flag. */
  watermarkPattern?: RegExp;
  /**
   * The Application Insights query client, or null when
   * `LOG_ANALYTICS_WORKSPACE_ID` is unset. Null makes the telemetry
   * partition an empty poll rather than a failure.
   */
  appInsights?: AppInsightsClient | null;
  /** The principal whose telemetry the telemetry partition reads (`lance.principal`). */
  principalId: string;
  now?: () => string;
  schedules?: readonly string[];
}

function unknownPartition(partition: string): Error {
  return new Error(
    `agent-logs watcher has no partition named "${partition}". Expected ${AGENT_LOGS_PARTITIONS.join(', ')}.`,
  );
}

export function createAgentLogsWatcher(options: AgentLogsWatcherOptions): Watcher {
  const now = options.now ?? nowIso;
  const watermarkPattern = options.watermarkPattern ?? DEFAULT_WATERMARK_PATTERN;
  const channel: SlackChannelOptions = {
    channelId: options.channelId,
    watermarkPattern,
    ...(options.ownBotUserId === undefined ? {} : { ownBotUserId: options.ownBotUserId }),
    ...(options.ownBotId === undefined ? {} : { ownBotId: options.ownBotId }),
  };

  return {
    name: AGENT_LOGS_WATCHER_NAME,
    // Log lines are for the stale-watermark and error detectors, not for a Sonnet triage call each.
    triage: false,
    // The watcher's own system. Each stream's observations carry the system
    // they came from: `slack`, `lance` and `webhook` (spec 7.1).
    sourceSystem: 'lance',
    schedules: [...(options.schedules ?? AGENT_LOGS_SCHEDULES)],

    partitions: () => Promise.resolve([...AGENT_LOGS_PARTITIONS]),

    poll(partition: string, cursor: string | null): Promise<PollResult> {
      if (partition === SLACK_PARTITION) return pollSlackChannel(options.slack, channel, cursor);
      if (partition === TELEMETRY_PARTITION) {
        return pollTelemetry(options.appInsights ?? null, options.principalId, cursor, now());
      }
      if (partition === WEBHOOK_PARTITION) return pollWebhook(cursor);
      return Promise.reject(unknownPartition(partition));
    },

    normalise(record, partition: string): Promise<Observation> {
      if (partition === SLACK_PARTITION) {
        return Promise.resolve(normaliseSlackMessage(record, watermarkPattern));
      }
      if (partition === TELEMETRY_PARTITION) return Promise.resolve(normaliseTelemetryRow(record));
      if (partition === WEBHOOK_PARTITION) {
        return Promise.reject(
          new Error(
            'agent-logs webhook partition has nothing to normalise: POST /ingest/agent-log writes those observations itself. See apps/worker/src/watchers/agent-logs/webhook.ts.',
          ),
        );
      }
      return Promise.reject(unknownPartition(partition));
    },
  };
}
