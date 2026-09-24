/**
 * The `agent-logs` watcher (spec 7.1) and the two alert kinds it owns
 * (spec 11). Registration lives in `main.ts`.
 */

export {
  AGENT_LOGS_PARTITIONS,
  AGENT_LOGS_SCHEDULES,
  AGENT_LOGS_WATCHER_NAME,
  createAgentLogsWatcher,
} from './watcher.js';
export type { AgentLogsWatcherOptions } from './watcher.js';

export {
  DEFAULT_WATERMARK_PATTERN,
  INBOX_AGENT,
  MAX_HISTORY_PAGES,
  SLACK_PARTITION,
  isOwnMessage,
  normaliseSlackMessage,
  parseWatermarkAt,
  pollSlackChannel,
  slackMessageUrl,
  slackTsToIso,
} from './slack.js';
export type { SlackAgentLogRecord, SlackChannelOptions, SlackHistoryReads } from './slack.js';

export {
  STEP_SKIPPED_DIMENSION,
  TELEMETRY_PARTITION,
  TELEMETRY_QUERY,
  TELEMETRY_SOURCE_SYSTEM,
  normaliseTelemetryRow,
  pollTelemetry,
  telemetryRecordSchema,
  telemetryRowToRaw,
  telemetryWindowStart,
} from './telemetry.js';
export type { TelemetryRecord } from './telemetry.js';

export { WEBHOOK_PARTITION, pollWebhook } from './webhook.js';

export {
  AGENT_LOGS_DETECTOR_SCHEDULE,
  STALE_WATERMARK_DEDUPE_KEY,
  watermarkThreshold,
  createAgentLogsDetector,
  readLatestWatermark,
  readRecentTelemetry,
  skippedSteps,
  staleWatermark,
  telemetryFromRows,
  watermarkAtOf,
} from './detect.js';
export type { AgentLogsDetectorOptions, ObservedRow } from './detect.js';
