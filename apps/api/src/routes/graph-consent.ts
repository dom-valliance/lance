import { isConnectorError } from '@lance/connectors';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  GRAPH_SCOPES,
} from '@lance/connectors/graph';
import { newUlid, nowIso } from '@lance/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createConsentStateStore } from '../auth/graph-state.js';
import { requireEntra } from '../auth/require-entra.js';
import { DOM_ACTOR, type ApiDeps, type GraphConsentDeps } from '../deps.js';
import { BadRequestError, HttpError } from '../errors.js';

/**
 * The delegated Graph consent flow (spec 4.1, docs/runbooks/entra-setup.md
 * section 7). Dom opens `/auth/graph/connect` once, consents, and Entra
 * returns him to `/auth/graph/callback` with an authorisation code. The
 * api swaps the code for the first token pair, stores the refresh token
 * and records the connection in the ledger.
 *
 * `connect` sits behind the Entra guard so only Dom can start a consent.
 * `callback` cannot: Entra sends the browser there with no bearer token.
 * Its protection is the `state` value, which only a `connect` in the last
 * ten minutes can have issued and which is good for one use.
 *
 * No route here logs or returns a code, a verifier or a token.
 */

const CallbackQuerySchema = z.looseObject({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

const redirectUri = (graph: GraphConsentDeps): string =>
  `${graph.publicApiUrl.replace(/\/+$/, '')}/auth/graph/callback`;

/**
 * Raised when the process was started without the Entra app credentials.
 * A 503 means the api's error handler sends the caller the generic
 * message and writes this one to the log, which is where an operator
 * looks anyway.
 */
export const graphConsentConfigurationError = (): HttpError =>
  new HttpError(
    503,
    'The Microsoft Graph consent flow is not configured on this api. Set PUBLIC_API_URL, ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and KEY_VAULT_URL, then restart the container.',
  );

const graphDeps = (deps: ApiDeps): GraphConsentDeps => {
  if (deps.graph === undefined) throw graphConsentConfigurationError();
  return deps.graph;
};

/** The page Dom sees when the consent has landed. */
export const connectedPage = (agentDisplayName: string): string =>
  `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${agentDisplayName} is connected</title>
  </head>
  <body>
    <main>
      <h1>${agentDisplayName} is connected</h1>
      <p>
        ${agentDisplayName} can now read your Microsoft 365 mail and calendar, and prepare drafts,
        categories and holds for your approval. It cannot send mail.
      </p>
      <p>You can close this tab.</p>
    </main>
  </body>
</html>
`;

export const graphConsentRoutes =
  (deps: ApiDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    // One store per registered plugin instance, so a test gets a fresh one.
    const states = createConsentStateStore();

    fastify.get('/auth/graph/connect', { onRequest: requireEntra(deps) }, (_request, reply) => {
      const graph = graphDeps(deps);
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      states.issue(state, codeVerifier);

      return reply.redirect(
        buildAuthorizeUrl({
          tenantId: graph.tenantId,
          clientId: graph.clientId,
          redirectUri: redirectUri(graph),
          state,
          codeVerifier,
        }),
        302,
      );
    });

    fastify.get('/auth/graph/callback', async (request, reply) => {
      const graph = graphDeps(deps);

      const parsed = CallbackQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new BadRequestError(
          'The consent callback query could not be read. Start again at /auth/graph/connect.',
        );
      }
      const query = parsed.data;

      if (query.error !== undefined) {
        throw new BadRequestError(
          `Microsoft Entra refused the consent with "${query.error}". Check the delegated permissions and admin consent in docs/runbooks/entra-setup.md section 3, then start again at /auth/graph/connect.`,
        );
      }

      if (query.state === undefined) {
        throw new BadRequestError(
          'The consent callback carried no state. Start again at /auth/graph/connect.',
        );
      }

      const codeVerifier = states.claim(query.state);
      if (codeVerifier === null) {
        throw new BadRequestError(
          'The consent state does not match a request made in the last ten minutes, or it has already been used. Start again at /auth/graph/connect.',
        );
      }

      if (query.code === undefined) {
        throw new BadRequestError(
          'The consent callback carried no authorisation code. Start again at /auth/graph/connect.',
        );
      }

      // A refusal from Entra is the caller's problem, not a server fault:
      // the code is single use and short lived. A retryable failure (a 5xx
      // or a network fault at Entra) stays a 500 so it is alerted on.
      let tokens;
      try {
        tokens = await exchangeCode({
          tenantId: graph.tenantId,
          clientId: graph.clientId,
          clientSecret: graph.clientSecret,
          redirectUri: redirectUri(graph),
          code: query.code,
          codeVerifier,
        });
      } catch (error) {
        if (isConnectorError(error) && !error.retryable) {
          throw new BadRequestError(
            'Microsoft Entra refused the authorisation code. It may have been used already or expired, or the client secret may be wrong. Start again at /auth/graph/connect and see docs/runbooks/entra-setup.md section 4.',
          );
        }
        throw error;
      }

      await graph.tokenStore.setRefreshToken(tokens.refreshToken);

      await deps.writer.append({
        ts: (deps.now ?? nowIso)(),
        actor: DOM_ACTOR,
        kind: 'state_changed',
        sourceSystem: 'graph',
        correlationId: newUlid(),
        payload: { change: 'graph_connected', scopes: [...GRAPH_SCOPES] },
      });

      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(connectedPage(deps.config.agentDisplayName));
    });
  };
