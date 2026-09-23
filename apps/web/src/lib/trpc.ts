import type { AppRouter } from '@lance/api/router';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { auth } from '@/auth';
import { apiBaseUrl } from './api';

/**
 * The server-side tRPC caller. Only server components, server actions and
 * route handlers use it: it forwards the signed-in user's Entra id token as
 * the bearer the api's `requireEntra` hook checks, and that token never
 * reaches the browser.
 *
 * `AppRouter` is imported as a type alone, so `@lance/api` is a
 * devDependency and `verbatimModuleSyntax` elides the import: no api
 * runtime code is bundled into the web app.
 */

export type ApiClient = ReturnType<typeof clientWithToken>;

const clientWithToken = (token: string | undefined) =>
  createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiBaseUrl()}/trpc`,
        headers: () => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
      }),
    ],
  });

/**
 * Throws when there is no session or no id token in it. Every page that
 * calls this sits behind the Auth.js proxy guard, so the throw means the
 * token is missing from the session rather than that the user is anonymous.
 */
export async function apiClient(): Promise<ApiClient> {
  const session = await auth();
  if (session === null) {
    throw new Error('No session. Sign in before calling the api.');
  }
  if (session.error !== undefined) {
    throw new Error('The Microsoft sign-in has lapsed and could not be renewed. Sign in again.');
  }
  if (session.idToken === undefined) {
    throw new Error(
      'The session carries no Entra id token. Sign out and in again so Auth.js can store one.',
    );
  }
  return clientWithToken(session.idToken);
}
