import NextAuth from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { isAllowedUpn } from './auth/allowlist';

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
  providers: [
    MicrosoftEntraID({
      clientId: readEnv('ENTRA_CLIENT_ID'),
      clientSecret: readEnv('ENTRA_CLIENT_SECRET'),
      issuer: `https://login.microsoftonline.com/${readEnv('ENTRA_TENANT_ID')}/v2.0`,
    }),
  ],
  callbacks: {
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
