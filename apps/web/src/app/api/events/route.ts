import { auth } from '@/auth';
import { serverIdToken } from '@/auth/id-token';
import { apiBaseUrl } from '@/lib/api';

/**
 * `GET /api/events`: the browser's end of the live feed. The page's
 * `EventSource` connects here, on the web app's own origin, and this
 * handler opens the api's `/events` stream on its behalf with the Entra id
 * token from the session as the bearer. The token stays on the server:
 * it never appears in a browser URL, a referrer or an access log.
 *
 * The upstream body is passed through untouched, so the Server-Sent Events
 * framing, the heartbeats and the connection comment all reach the
 * browser exactly as the api wrote them.
 */

export const dynamic = 'force-dynamic';

/** Headers that keep proxies from buffering or caching the stream. */
const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
} as const;

export interface EventsProxyDeps {
  idToken: () => Promise<string | undefined>;
  fetchImpl: typeof fetch;
  upstreamUrl: string;
}

export function createEventsProxy(deps: EventsProxyDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const idToken = await deps.idToken();
    if (idToken === undefined) {
      return Response.json(
        { error: 'No session. Sign in again to receive live updates.' },
        { status: 401 },
      );
    }

    const upstream = await deps.fetchImpl(deps.upstreamUrl, {
      headers: { authorization: `Bearer ${idToken}`, accept: 'text/event-stream' },
      // Closing the browser's connection closes the api's, so the api
      // drops its subscriber rather than streaming into the void.
      signal: request.signal,
    });

    if (!upstream.ok || upstream.body === null) {
      return Response.json(
        { error: `The api refused the live feed with status ${String(upstream.status)}.` },
        { status: upstream.status === 401 ? 401 : 502 },
      );
    }

    return new Response(upstream.body, { status: 200, headers: STREAM_HEADERS });
  };
}

async function sessionIdToken(): Promise<string | undefined> {
  const session = await auth();
  if (session === null || session.error !== undefined) return undefined;
  return serverIdToken();
}

export const GET = createEventsProxy({
  idToken: sessionIdToken,
  fetchImpl: fetch,
  upstreamUrl: `${apiBaseUrl()}/events`,
});
