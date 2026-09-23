import NextAuth from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { isAllowedUpn } from './auth/allowlist';
import { jwtExpiresAt, needsRefresh, refreshEntraTokens } from './auth/refresh';

/**
 * The Entra id token is kept in the Auth.js JWT and exposed on the session
 * for server-side code only (see lib/trpc.ts). `apps/api` verifies the same
 * token, so the web app forwards it rather than minting a second credential.
 * Entra issues it for about an hour; the refresh token beside it renews it
 * silently (see auth/refresh.ts), and when renewal fails the session
 * carries `error` and the proxy sends the reader back to sign in.
 *
 * Only `Session` is augmented. `JWT` lives in `@auth/core/jwt`, which
 * `next-auth/jwt` re-exports without redeclaring, so augmenting it here
 * would not reach the interface; the JWT already carries an index
 * signature of `unknown`, so the claims are read back with a type check.
 */
declare module 'next-auth' {
  interface Session {
    idToken?: string;
    error?: typeof REFRESH_ERROR;
  }
}

/** Where the Entra tokens are kept in the Auth.js JWT. */
const ID_TOKEN_CLAIM = 'idToken';
const REFRESH_TOKEN_CLAIM = 'refreshToken';
const EXPIRES_AT_CLAIM = 'expiresAt';
const ERROR_CLAIM = 'error';
const REFRESH_ERROR = 'RefreshTokenError';

/** `offline_access` is what returns a refresh token; the rest is the provider's default. */
const SCOPE = 'openid profile email User.Read offline_access';

function claimString(token: Record<string, unknown>, claim: string): string | null {
  const value = token[claim];
  return typeof value === 'string' && value !== '' ? value : null;
}

function claimNumber(token: Record<string, unknown>, claim: string): number | null {
  const value = token[claim];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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
      authorization: { params: { scope: SCOPE } },
    }),
  ],
  callbacks: {
    // The account is present only on the sign-in call, which stores the
    // tokens. Every later call checks the id token's own expiry and renews
    // it through the refresh token while there is still time; a refusal
    // marks the token so the session ends rather than failing every page.
    async jwt({ token, account }) {
      if (account !== null && account !== undefined && typeof account.id_token === 'string') {
        token[ID_TOKEN_CLAIM] = account.id_token;
        token[REFRESH_TOKEN_CLAIM] = account.refresh_token ?? null;
        token[EXPIRES_AT_CLAIM] = jwtExpiresAt(account.id_token) ?? account.expires_at ?? null;
        delete token[ERROR_CLAIM];
        return token;
      }
      if (token[ERROR_CLAIM] === REFRESH_ERROR) return token;
      const idToken = claimString(token, ID_TOKEN_CLAIM);
      const expiresAt =
        claimNumber(token, EXPIRES_AT_CLAIM) ?? (idToken === null ? null : jwtExpiresAt(idToken));
      if (!needsRefresh(expiresAt, Date.now())) return token;
      const refreshToken = claimString(token, REFRESH_TOKEN_CLAIM);
      if (refreshToken === null) return { ...token, [ERROR_CLAIM]: REFRESH_ERROR };
      try {
        const fresh = await refreshEntraTokens({
          tenantId: readEnv('ENTRA_TENANT_ID'),
          clientId: readEnv('ENTRA_CLIENT_ID'),
          clientSecret: readEnv('ENTRA_CLIENT_SECRET'),
          refreshToken,
          scope: SCOPE,
        });
        return {
          ...token,
          [ID_TOKEN_CLAIM]: fresh.idToken,
          [REFRESH_TOKEN_CLAIM]: fresh.refreshToken ?? refreshToken,
          [EXPIRES_AT_CLAIM]: fresh.expiresAt,
        };
      } catch {
        return { ...token, [ERROR_CLAIM]: REFRESH_ERROR };
      }
    },
    // Server components read `session.idToken`. Auth.js does not send the
    // session object to the browser wholesale; the client-side `useSession`
    // payload is built from the `session` callback too, so nothing here may
    // be added to it that a page does not already trust the server with.
    session({ session, token }) {
      if (token[ERROR_CLAIM] === REFRESH_ERROR) {
        session.error = REFRESH_ERROR;
        return session;
      }
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
    // to the sign-in page when there is none or when its Entra token could
    // not be renewed. Signing in again replaces the cookie.
    authorized({ auth: session }) {
      return session?.user !== undefined && session.error === undefined;
    },
  },
});
