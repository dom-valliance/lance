import { auth } from '@/auth';
import { apiBaseUrl } from '@/lib/api';

/**
 * `GET /api/graph/connect`: the Settings page's Connect Microsoft 365
 * button lands here. The api's `/auth/graph/connect` sits behind Entra
 * bearer authentication, and the id token lives only in the server-side
 * session, so this handler makes that call on the browser's behalf and
 * forwards the browser to the Microsoft consent URL the api answered
 * with. The token never reaches the browser (spec 4.1, runbook
 * entra-setup.md section 7).
 */

export const dynamic = 'force-dynamic';

export interface ConnectProxyDeps {
  idToken: () => Promise<string | undefined>;
  fetchImpl: typeof fetch;
  connectUrl: string;
}

export function createConnectProxy(deps: ConnectProxyDeps): () => Promise<Response> {
  return async (): Promise<Response> => {
    const idToken = await deps.idToken();
    if (idToken === undefined) {
      return Response.json(
        { error: 'No session. Sign in again, then press Connect Microsoft 365.' },
        { status: 401 },
      );
    }

    const upstream = await deps.fetchImpl(deps.connectUrl, {
      headers: { authorization: `Bearer ${idToken}` },
      // The api answers with a redirect to Microsoft; the browser must
      // follow it, not this server.
      redirect: 'manual',
    });

    const location = upstream.headers.get('location');
    if (upstream.status !== 302 || location === null) {
      return Response.json(
        {
          error: `The api did not start the consent (status ${String(upstream.status)}). Check the api log for the Graph consent configuration message.`,
        },
        { status: 502 },
      );
    }
    return Response.redirect(location, 302);
  };
}

async function sessionIdToken(): Promise<string | undefined> {
  const session = await auth();
  return session?.idToken;
}

export const GET = createConnectProxy({
  idToken: sessionIdToken,
  fetchImpl: fetch,
  connectUrl: `${apiBaseUrl()}/auth/graph/connect`,
});
