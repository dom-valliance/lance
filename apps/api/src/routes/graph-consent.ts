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
import { CONSENT_STATE_TTL_MINUTES, principalOfState, stateFor } from '../auth/graph-state.js';
import { requireConnectable, requireEntra, verifiedCaller } from '../auth/require-entra.js';
import type { GraphConsentDeps, ServerDeps } from '../deps.js';
import { BadRequestError, ForbiddenError, HttpError, UnauthorisedError } from '../errors.js';
import { constantTimeEquals } from '../secure-compare.js';

/**
 * The delegated Graph consent flow (spec 4.1, docs/runbooks/entra-setup.md
 * section 7). A principal opens `/auth/graph/connect` once, consents, and
 * Entra returns them to `/auth/graph/callback` with an authorisation code. The
 * api swaps the code for the first token pair, stores the refresh token
 * and records the connection in the ledger.
 *
 * Three legs, because the web calls `connect` server side on the
 * browser's behalf and the api and the web answer on different hostnames:
 *
 * 1. `connect` sits behind the Entra guard, so only an active or
 *    onboarding principal can start a consent. It stores the state in
 *    Postgres under that principal (migration 0021) and sends the browser
 *    to `begin` on the api's own hostname.
 * 2. `begin` binds the state, once, to the browser that opens it with an
 *    HttpOnly, SameSite=Lax cookie on the api's hostname, and sends it to
 *    Entra with the principal's UPN as the login hint.
 * 3. `callback` arrives with no bearer token. It needs the state, the
 *    cookie that matches it, and an id token from the code exchange whose
 *    `oid` is the principal's own Entra object and whose `tid` is the
 *    tenant. A consent link forwarded to someone else fails the cookie; a
 *    browser that consents as another account fails the id token. Either
 *    way nothing is stored.
 *
 * The callback then records its intent in the principal's ledger, writes
 * the principal's own secret, `graph-refresh-token--<principalId>` in the
 * principal vault (ADR 0022), which the api can set and never read back,
 * and records the connection (ledger first, non-negotiable 1).
 *
 * No route here logs or returns a code, a verifier or a token.
 */

const CallbackQuerySchema = z.looseObject({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

const apiOrigin = (graph: GraphConsentDeps): string => graph.publicApiUrl.replace(/\/+$/, '');

const redirectUri = (graph: GraphConsentDeps): string => `${apiOrigin(graph)}/auth/graph/callback`;

/** The cookie that ties a consent to the browser that began it. */
export const CONSENT_COOKIE = 'lance_graph_consent';

const consentCookie = (graph: GraphConsentDeps, value: string, maxAgeSeconds: number): string =>
  [
    `${CONSENT_COOKIE}=${value}`,
    'Path=/auth/graph',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
    ...(apiOrigin(graph).startsWith('https://') ? ['Secure'] : []),
  ].join('; ');

/** The consent cookie's value from a Cookie header, or null. */
export const consentCookieValue = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CONSENT_COOKIE) return rest.join('=');
  }
  return null;
};

const StateQuerySchema = z.looseObject({ state: z.string().min(1).optional() });

const CONSENT_STATE_TTL_SECONDS = CONSENT_STATE_TTL_MINUTES * 60;

const START_AGAIN = 'Start again from Settings, Connect Microsoft 365.';

/**
 * Raised when the process was started without the Entra app credentials.
 * A 503 means the api's error handler sends the caller the generic
 * message and writes this one to the log, which is where an operator
 * looks anyway.
 */
export const graphConsentConfigurationError = (): HttpError =>
  new HttpError(
    503,
    'The Microsoft Graph consent flow is not configured on this api. Set PUBLIC_API_URL, ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and PRINCIPAL_KEY_VAULT_URL, then restart the container.',
  );

const graphDeps = (server: ServerDeps): GraphConsentDeps => {
  if (server.graph === undefined) throw graphConsentConfigurationError();
  return server.graph;
};

/** The page the principal sees when the consent has landed. */
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
    const refuse = async (
      principal: { id: string; upn: string },
      reason: string,
    ): Promise<void> => {
      const deps = server.depsFor(principal);
      await deps.writer.append({
        ts: (server.now ?? nowIso)(),
        actor: deps.actor,
        kind: 'failed',
        sourceSystem: 'graph',
        correlationId: newUlid(),
        payload: { change: 'graph_consent_refused', reason },
      });
    };

    fastify.get(
      '/auth/graph/connect',
      { onRequest: requireEntra(server) },
      async (request, reply) => {
        const caller = requireConnectable(verifiedCaller(request));
        const graph = graphDeps(server);
        const state = stateFor(caller.principal.id, generateState());
        await graph.states.issue(caller.principal.id, state, generateCodeVerifier());

        const begin = new URL(`${apiOrigin(graph)}/auth/graph/begin`);
        begin.searchParams.set('state', state);
        return reply.redirect(begin.toString(), 302);
      },
    );

    fastify.get('/auth/graph/begin', async (request, reply) => {
      const graph = graphDeps(server);
      const parsed = StateQuerySchema.safeParse(request.query);
      const state = parsed.success ? parsed.data.state : undefined;
      const bound = state === undefined ? null : await graph.states.bind(state);
      if (state === undefined || bound === null) {
        throw new BadRequestError(
          `This consent link has already been used, has expired or was not issued by Lance. ${START_AGAIN}`,
        );
      }

      return reply
        .header('set-cookie', consentCookie(graph, state, CONSENT_STATE_TTL_SECONDS))
        .redirect(
          buildAuthorizeUrl({
            tenantId: graph.tenantId,
            clientId: graph.clientId,
            redirectUri: redirectUri(graph),
            state,
            codeVerifier: bound.codeVerifier,
            loginHint: bound.principal.upn,
          }),
          302,
        );
    });

    fastify.get('/auth/graph/callback', async (request, reply) => {
      const graph = graphDeps(server);

      const parsed = CallbackQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new BadRequestError(`The consent callback query could not be read. ${START_AGAIN}`);
      }
      const query = parsed.data;

      if (query.error !== undefined) {
        throw new BadRequestError(
          `Microsoft Entra refused the consent with "${query.error}". Check the delegated permissions and admin consent in docs/runbooks/entra-setup.md section 3, then start again from Settings, Connect Microsoft 365.`,
        );
      }

      if (query.state === undefined || principalOfState(query.state) === null) {
        throw new BadRequestError(`The consent callback carried no usable state. ${START_AGAIN}`);
      }

      // The browser that began this consent holds its cookie; any other does not.
      const cookie = consentCookieValue(request.headers.cookie);
      if (cookie === null || !constantTimeEquals(cookie, query.state)) {
        throw new BadRequestError(
          `This consent was not started in this browser. Open Settings in the browser you use for Lance and press Connect Microsoft 365 there. ${START_AGAIN}`,
        );
      }

      const claimed = await graph.states.claim(query.state);
      if (claimed === null) {
        throw new BadRequestError(
          `The consent state does not match a request made in the last ten minutes, or it has already been used. ${START_AGAIN}`,
        );
      }

      if (query.code === undefined) {
        throw new BadRequestError(
          `The consent callback carried no authorisation code. ${START_AGAIN}`,
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
            `Microsoft Entra refused the authorisation code. It may have been used already or expired, or the client secret may be wrong. See docs/runbooks/entra-setup.md section 4. ${START_AGAIN}`,
          );
        }
        throw error;
      }

      // The account that consented must be the principal who started the
      // consent, in this tenant. Anything else stores nothing.
      const principal = { id: claimed.principal.id, upn: claimed.principal.upn };
      let consented;
      try {
        if (tokens.idToken === undefined) {
          throw new UnauthorisedError('Microsoft Entra returned no id token.');
        }
        consented = await server.auth.verify(tokens.idToken);
      } catch (error) {
        if (!(error instanceof UnauthorisedError)) throw error;
        await refuse(principal, 'id_token_unverified');
        throw new BadRequestError(
          `Microsoft Entra did not return a verifiable id token for this consent, so nothing was stored. Confirm "openid" is among the granted scopes. ${START_AGAIN}`,
        );
      }
      if (
        consented.tid !== graph.tenantId ||
        claimed.principal.entraOid === null ||
        consented.oid !== claimed.principal.entraOid
      ) {
        await refuse(principal, 'account_mismatch');
        throw new ForbiddenError(
          `Microsoft 365 was consented to by a different account from the one that started the consent, so nothing was stored. Sign in to Microsoft as ${claimed.principal.upn} and start again from Settings, Connect Microsoft 365.`,
        );
      }

      // Ledger first: the intent, the secret, then the connection that
      // onboarding reads.
      const deps = server.depsFor(principal);
      const correlationId = newUlid();
      const record = (change: string): Promise<unknown> =>
        deps.writer.append({
          ts: (server.now ?? nowIso)(),
          actor: deps.actor,
          kind: 'state_changed',
          sourceSystem: 'graph',
          correlationId,
          payload: { change, scopes: [...GRAPH_SCOPES] },
        });
      await record('graph_token_storing');
      await graph.tokenWriterFor(claimed.principal.id).setRefreshToken(tokens.refreshToken);
      await record('graph_connected');

      return reply
        .code(200)
        .header('set-cookie', consentCookie(graph, '', 0))
        .type('text/html; charset=utf-8')
        .send(connectedPage(server.config.agentDisplayName));
    });
  };
