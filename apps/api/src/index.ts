export const APP_NAME = '@lance/api';

export { buildServer, loggerOptions, LOGGER_REDACT_PATHS } from './server.js';
export { DOM_ACTOR } from './deps.js';
export type {
  ApiDeps,
  LedgerReaderLike,
  LedgerWriterLike,
  SlackDeps,
  SystemControlLike,
  TokenVerifier,
} from './deps.js';
export { createEntraVerifier, entraIssuer } from './auth/entra.js';
export type { EntraVerifierOptions } from './auth/entra.js';
export { requireEntra, verifiedUpn } from './auth/require-entra.js';
export { verifySlackSignature, slackSignature, REPLAY_WINDOW_SECONDS } from './slack/verify.js';
export type { SlackSignatureInput, SlackVerification } from './slack/verify.js';
export { createDbStatusSource, renderStatus, startOfLocalDay } from './status.js';
export type {
  CursorStatus,
  DbStatusSourceOptions,
  StatusSnapshot,
  StatusSource,
} from './status.js';
export { agentLogActor, AgentLogSchema, INGEST_SECRET_HEADER } from './routes/ingest.js';
export type { AgentLog } from './routes/ingest.js';
export { appRouter } from './router.js';
export type { AppRouter } from './router.js';
export { BadRequestError, HttpError, UnauthorisedError } from './errors.js';
