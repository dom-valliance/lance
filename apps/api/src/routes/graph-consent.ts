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
import { requireActive, requireEntra, verifiedCaller } from '../auth/require-entra.js';
import type { GraphConsentDeps, ServerDeps } from '../deps.js';
import { BadRequestError, ForbiddenError, HttpError } from '../errors.js';

/**
 * The delegated Graph consent flow (spec 4.1, docs/runbooks/entra-setup.md
 * section 7). Dom opens `/auth/graph/connect` once, consents, and Entra
 * returns him to `/auth/graph/callback` with an authorisation code. The
 * api swaps the code for the first token pair, stores the refresh token
 * and records the connection in the ledger.
 *
 * `connect` sits behind the Entra guard, so only an active principal can
 * start a consent, and the state remembers which one did. The token store
 * is still the one secret until package 5.2 makes it per principal, so
 * until then only the principal in DOM_EMAIL may connect.
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

const graphDeps = (server: ServerDeps): GraphConsentDeps => {
  if (server.graph === undefined) throw graphConsentConfigurationError();
  return server.graph;
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
  (server: ServerDeps): FastifyPluginAsync =>
  // eslint-disable-next-line @typescript-eslint/require-await
  async (fastify): Promise<void> => {
    // One store per registered plugin instance, so a test gets a fresh one.
    const states = createConsentStateStore();

    fastify.get('/auth/graph/connect', { onRequest: requireEntra(server) }, (request, reply) => {
      const caller = requireActive(verifiedCaller(request));
      if (caller.principal.upn.toLowerCase() !== server.config.dom.email.toLowerCase()) {
        throw new ForbiddenError(
          `Lance holds one Microsoft 365 connection for now, and it belongs to ${server.config.dom.email}. Connections for other accounts are not open yet.`,
        );
      }
      const graph = graphDeps(server);
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      states.issue(state, codeVerifier, {
        id: caller.principal.id,
        upn: caller.principal.upn,
      });

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
      const graph = graphDeps(server);

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

      const claimed = states.claim(query.state);
      if (claimed === null) {
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
          codeVerifier: claimed.codeVerifier,
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

      const deps = server.depsFor(claimed.principal);
      await deps.writer.append({
        ts: (server.now ?? nowIso)(),
        actor: deps.actor,
        kind: 'state_changed',
        sourceSystem: 'graph',
        correlationId: newUlid(),
        payload: { change: 'graph_connected', scopes: [...GRAPH_SCOPES] },
      });

      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(connectedPage(server.config.agentDisplayName));
    });
  };
