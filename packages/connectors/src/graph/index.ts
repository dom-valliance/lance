/**
 * The Microsoft Graph connector: delegated auth, the token store, the
 * access token provider, the client and every read (spec 4.1, 4.2, 7.1,
 * 8).
 *
 * Writes are deliberately absent. `graphWrites` is exported from
 * `./writes.js` and reaches the rest of the repository only through
 * `@lance/connectors/writes`, which the ESLint boundary limits to
 * `apps/worker/src/executor` (non-negotiable 2).
 */

export {
  authorizeEndpoint,
  buildAuthorizeUrl,
  codeChallengeFor,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  GRAPH_SCOPE_STRING,
  GRAPH_SCOPES,
  refreshAccessToken,
  TokenRefreshError,
  tokenEndpoint,
} from './auth.js';
export type {
  AuthorizeUrlOptions,
  ExchangeCodeOptions,
  GraphTokens,
  RefreshAccessTokenOptions,
} from './auth.js';

export {
  GRAPH_REFRESH_TOKEN_SECRET_NAME,
  InMemoryTokenStore,
  KeyVaultTokenStore,
  PENDING_FIRST_CONSENT,
} from './tokenStore.js';
export type { GraphTokenStore, SecretClientLike } from './tokenStore.js';

export { createAccessTokenProvider } from './accessToken.js';
export type { AccessTokenProvider, AccessTokenProviderOptions } from './accessToken.js';

export { createGraphConnector, GRAPH_BASE_URL, GRAPH_POLICY } from './client.js';
export type { GraphConnector, GraphConnectorOptions, GraphRequest } from './client.js';

export { createGraphReads, EVENT_SELECT, MESSAGE_SELECT } from './reads.js';
export type { DeltaCalendarViewOptions, DeltaMessagesOptions, GraphReads } from './reads.js';

export * from './types.js';
