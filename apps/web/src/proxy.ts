// Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`
// (https://nextjs.org/docs/app/api-reference/file-conventions/proxy);
// `middleware.ts` still loads but is deprecated. Auth.js's `auth` export
// doubles as the proxy function: on its own it redirects any request
// without a valid session to the sign-in page, which is exactly the "every
// route except the three below" guard this work package asks for. The
// allowlist itself is enforced earlier, in the signIn callback in auth.ts:
// a disallowed UPN never receives a session, so it never gets past here.
export { auth as proxy } from '@/auth';

export const config = {
  // Everything runs through the guard except the Auth.js API routes
  // (needed to sign in and out in the first place), the self-hosted font
  // files, and Next's own internal asset paths.
  matcher: ['/((?!api/auth|fonts/|_next/).*)'],
};
