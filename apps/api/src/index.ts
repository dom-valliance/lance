export const APP_NAME = '@lance/api';

export { buildServer, loggerOptions, scrubAccessToken, LOGGER_REDACT_PATHS } from './server.js';
export { DOM_ACTOR } from './deps.js';
export type {
  ApiDeps,
  LedgerReaderLike,
  LedgerWriterLike,
  ProposalStoreLike,
  SlackDeps,
  SystemControlLike,
  TokenVerifier,
} from './deps.js';
export { actorFromUpn } from './actor.js';
export { createFeed, FeedEventSchema } from './events.js';
export type { Feed, FeedEvent, FeedListener } from './events.js';
export { createExecuteQueue, EXECUTE_QUEUE } from './executeQueue.js';
export type { ExecuteJob, ExecuteQueue } from './executeQueue.js';
export { applyDecision } from './proposals/decide.js';
export type { DecideDeps, DecisionRequest } from './proposals/decide.js';
export { handleInteraction, SNOOZE_HOURS } from './slack/interactions.js';
export type { InteractionOutcome } from './slack/interactions.js';
export { eventsRoutes, HEARTBEAT_MS } from './routes/events.js';
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
export { appRouter, DecideInputSchema, ProposalFilterInputSchema } from './router.js';
export type { AppRouter, DecideInput, ProposalFilterInput } from './router.js';
export { createCallerFactory } from './trpc.js';
export { BadRequestError, HttpError, UnauthorisedError } from './errors.js';
