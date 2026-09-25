import { headers } from 'next/headers';
import { getToken } from 'next-auth/jwt';
import { ID_TOKEN_CLAIM } from './session';

/**
 * The signed-in principal's Entra id token, for server-side code alone.
 *
 * The token lives in the encrypted Auth.js JWT cookie and is never copied
 * onto the session, because `/api/auth/session` serves the session to
 * browser JavaScript. Server components, server actions and route
 * handlers read it here, straight from the JWT, when they call the api on
 * the principal's behalf (lib/trpc.ts, the SSE and consent proxies).
 *
 * The proxy renews the token two minutes before it expires and writes the
 * renewed cookie on its response, so a handler reading the request's
 * cookie holds a token that is still inside its lifetime.
 */

/** The id token a decoded JWT carries, or undefined when it carries none or its renewal failed. */
export function idTokenFromJwt(jwt: Record<string, unknown> | null): string | undefined {
  if (jwt === null || jwt['error'] !== undefined) return undefined;
  const value = jwt[ID_TOKEN_CLAIM];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the id token from the request's session cookie. Tries the
 * `__Secure-` cookie an https deployment sets, then the plain one a local
 * http run sets.
 */
export async function serverIdToken(): Promise<string | undefined> {
  const secret = process.env['AUTH_SECRET'];
  if (secret === undefined || secret === '') {
    throw new Error(
      'AUTH_SECRET is not set, so the session cookie cannot be read. Set it and restart the web app.',
    );
  }
  const requestHeaders = await headers();
  for (const secureCookie of [true, false]) {
    const jwt = await getToken({ req: { headers: requestHeaders }, secret, secureCookie });
    if (jwt !== null) return idTokenFromJwt(jwt);
  }
  return undefined;
}
