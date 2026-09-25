export const PACKAGE_NAME = '@lance/telemetry';

export { initTelemetry } from './otel.js';
export type { TelemetryConfig, TelemetryHandle } from './otel.js';

export {
  ATTR_AGENT,
  ATTR_CONNECTOR,
  ATTR_CORRELATION_ID,
  ATTR_PRINCIPAL,
  ATTR_PROPOSAL_ID,
  ATTR_REQUEST_HASH,
  currentTraceIds,
  principalOf,
  PrincipalSpanProcessor,
  withPrincipal,
  withSpan,
} from './span.js';

export { createLogger } from './logger.js';
export type { LoggerConfig } from './logger.js';
