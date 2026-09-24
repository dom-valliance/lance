import NextAuth from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import {
  fetchPrincipalStatus,
  PRINCIPAL_STATUSES,
  redirectFor,
  type PrincipalStatus,
} from './auth/principal';
import { jwtExpiresAt, needsRefresh, refreshEntraTokens } from './auth/refresh';
import {
  admitsSignIn,
  hasLanceAccess,
  identityFromIdToken,
  lanceRolesFrom,
  type LanceRole,
} from './auth/roles';
import { apiBaseUrl } from './lib/api';

/**
 * The Entra id token is kept in the Auth.js JWT and exposed on the session
 * for server-side code only (see lib/trpc.ts). `apps/api` verifies the same
 * token, so the web app forwards it rather than minting a second credential.
 * Entra issues it for about an hour; the refresh token beside it renews it
 * silently (see auth/refresh.ts), and when renewal fails the session
 * carries `error` and the proxy sends the reader back to sign in.
 *
 * Access comes from Entra app roles (ADR 0020): a token without Lance.User
 * or Lance.Admin gets no session, and a renewal that comes back without
 * one ends the session. The roles, the Entra object id and the principal's
 * status travel in the JWT so the proxy can send an onboarding principal
 * to the placeholder page without calling the api on every request.
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
    roles?: LanceRole[];
    oid?: string;
    /** Null when the api could not say at sign-in; the pages then load and the api decides. */
    principalStatus?: PrincipalStatus | null;
  }
}

/** Where the Entra tokens are kept in the Auth.js JWT. */
const ID_TOKEN_CLAIM = 'idToken';
const REFRESH_TOKEN_CLAIM = 'refreshToken';
const EXPIRES_AT_CLAIM = 'expiresAt';
const ERROR_CLAIM = 'error';
const ROLES_CLAIM = 'roles';
const OID_CLAIM = 'oid';
const STATUS_CLAIM = 'principalStatus';
const STATUS_CHECKED_AT_CLAIM = 'principalStatusCheckedAt';
const REFRESH_ERROR = 'RefreshTokenError';

/** How long an unknown principal status stands before the api is asked again. */
const STATUS_RETRY_MS = 60_000;

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

function claimStatus(token: Record<string, unknown>): PrincipalStatus | null {
  const value = token[STATUS_CLAIM];
  return typeof value === 'string' && (PRINCIPAL_STATUSES as readonly string[]).includes(value)
    ? (value as PrincipalStatus)
    : null;
}

/**
 * Copies the roles and object id of a fresh id token into the JWT and asks
 * the api for the principal's status, which on a first sign-in also binds
 * or creates the principal.
 */
async function stampIdentity(
  token: Record<string, unknown>,
  idToken: string,
): Promise<Record<string, unknown>> {
  const identity = identityFromIdToken(idToken);
  return {
    ...token,
    [ROLES_CLAIM]: identity.roles,
    [OID_CLAIM]: identity.oid,
    [STATUS_CLAIM]: await fetchPrincipalStatus(idToken, apiBaseUrl()),
    [STATUS_CHECKED_AT_CLAIM]: Date.now(),
  };
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
        return stampIdentity(token, account.id_token);
      }
      if (token[ERROR_CLAIM] === REFRESH_ERROR) return token;
      const idToken = claimString(token, ID_TOKEN_CLAIM);
      const expiresAt =
        claimNumber(token, EXPIRES_AT_CLAIM) ?? (idToken === null ? null : jwtExpiresAt(idToken));
      if (!needsRefresh(expiresAt, Date.now())) {
        const checkedAt = claimNumber(token, STATUS_CHECKED_AT_CLAIM) ?? 0;
        const retry = claimStatus(token) === null && Date.now() - checkedAt > STATUS_RETRY_MS;
        return retry && idToken !== null ? stampIdentity(token, idToken) : token;
      }
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
        // Entra keeps issuing tokens only while the person holds a role;
        // a renewed token without one ends the session here as well.
        if (!hasLanceAccess(identityFromIdToken(fresh.idToken).roles)) {
          return { ...token, [ERROR_CLAIM]: REFRESH_ERROR };
        }
        return stampIdentity(
          {
            ...token,
            [ID_TOKEN_CLAIM]: fresh.idToken,
            [REFRESH_TOKEN_CLAIM]: fresh.refreshToken ?? refreshToken,
            [EXPIRES_AT_CLAIM]: fresh.expiresAt,
          },
          fresh.idToken,
        );
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
      session.roles = lanceRolesFrom(token[ROLES_CLAIM]);
      const oid = claimString(token, OID_CLAIM);
      if (oid !== null) session.oid = oid;
      session.principalStatus = claimStatus(token);
      return session;
    },
    // `profile` holds the id token's claims. Neither Lance role means no
    // session: Auth.js sends the browser to /sign-in?error=AccessDenied.
    signIn({ profile }) {
      return admitsSignIn(profile);
    },
    // `auth` doubling as the proxy (see proxy.ts) only attaches the session
    // to the request; it does not deny access on its own. This callback is
    // what actually makes every matched route require a session, redirecting
    // to the sign-in page when there is none or when its Entra token could
    // not be renewed. Signing in again replaces the cookie.
    // An onboarding principal is sent to the placeholder page, and anyone
    // else away from it.
    authorized({ auth: session, request }) {
      if (session?.user === undefined || session.error !== undefined) return false;
      const target = redirectFor(session.principalStatus, request.nextUrl.pathname);
      return target === null ? true : Response.redirect(new URL(target, request.nextUrl));
    },
  },
});
