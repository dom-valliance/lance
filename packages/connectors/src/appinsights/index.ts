/**
 * The Application Insights connector: one read, no writes. It exists for
 * the `agent-logs` watcher's telemetry stream (spec 7.1), which reads
 * Lance's own failed spans and skipped steps out of Log Analytics.
 */
export {
  appInsightsPolicy,
  appInsightsQueryResponseSchema,
  createAppInsightsClient,
  logAnalyticsQueryUrl,
  rowsFromResponse,
  LOG_ANALYTICS_BASE_URL,
  LOG_ANALYTICS_SCOPE,
} from './client.js';
export type {
  AppInsightsClient,
  AppInsightsClientOptions,
  AppInsightsQueryRequest,
  AppInsightsQueryResponse,
  AppInsightsRow,
} from './client.js';
