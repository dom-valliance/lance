import NextAuth from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { isAllowedUpn } from './auth/allowlist';

/**
 * The Entra id token is kept in the Auth.js JWT and exposed on the session
 * for server-side code only (see lib/trpc.ts). `apps/api` verifies the same
 * token, so the web app forwards it rather than minting a second credential.
 *
 * Only `Session` is augmented. `JWT` lives in `@auth/core/jwt`, which
 * `next-auth/jwt` re-exports without redeclaring, so augmenting it here
 * would not reach the interface; the JWT already carries an index
 * signature of `unknown`, so the claim is read back with a type check.
 */
declare module 'next-auth' {
  interface Session {
    idToken?: string;
  }
}

/** Where the Entra id token is kept in the Auth.js JWT. */
const ID_TOKEN_CLAIM = 'idToken';

// process.env values are `string | undefined`; falling back to an empty
// string keeps this typed as `string` (required by exactOptionalPropertyTypes)
// without asserting the value is actually present. A missing value produces
// an inert, non-functioning provider rather than a build-time crash, and
// next-auth reports the misconfiguration clearly the first time it is used.
function readEnv(name: string): string {
  return process.env[name] ?? '';
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Runs on Azure Container Apps, never on Vercel, so Auth.js must be told to
  // trust the incoming request's Host header explicitly.
  trustHost: true,
  session: { strategy: 'jwt' },
  // Auth.js's own sign-in and error screens are replaced by /sign-in
  // (design 7.12). Both point at the same page: a refused account arrives
  // there with `?error=AccessDenied`, which the page reads as a code and
  // answers with copy of its own.
  pages: { signIn: '/sign-in', error: '/sign-in' },
  providers: [
    MicrosoftEntraID({
      clientId: readEnv('ENTRA_CLIENT_ID'),
      clientSecret: readEnv('ENTRA_CLIENT_SECRET'),
      issuer: `https://login.microsoftonline.com/${readEnv('ENTRA_TENANT_ID')}/v2.0`,
    }),
  ],
  callbacks: {
    // The account is present only on the sign-in call; on every later call
    // the token already carries what that one stored.
    jwt({ token, account }) {
      if (typeof account?.id_token === 'string') {
        token[ID_TOKEN_CLAIM] = account.id_token;
      }
      return token;
    },
    // Server components read `session.idToken`. Auth.js does not send the
    // session object to the browser wholesale; the client-side `useSession`
    // payload is built from the `session` callback too, so nothing here may
    // be added to it that a page does not already trust the server with.
    session({ session, token }) {
      const idToken = token[ID_TOKEN_CLAIM];
      if (typeof idToken === 'string') {
        session.idToken = idToken;
      }
      return session;
    },
    signIn({ profile, user }) {
      const allowedUpn = process.env['ALLOWED_UPN'];
      if (!allowedUpn) {
        return false;
      }
      const candidate = profile?.preferred_username ?? user.email;
      return isAllowedUpn(candidate, allowedUpn);
    },
    // `auth` doubling as the proxy (see proxy.ts) only attaches the session
    // to the request; it does not deny access on its own. This callback is
    // what actually makes every matched route require a session, redirecting
    // to the sign-in page when there is none.
    authorized({ auth: session }) {
      return session?.user !== undefined;
    },
  },
});
