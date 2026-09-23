import { signOut } from '@/auth';

/**
 * Sign-out as a plain form post to a fixed URL rather than a server action.
 * A server action is addressed by an id minted at build time; a page
 * rendered by the previous build keeps the old id, and after a deploy its
 * Sign out button answered "Failed to find Server Action". A URL survives
 * a deploy. Auth.js clears the session cookie and redirects.
 */

export interface SignOutDeps {
  signOut: (options: { redirectTo: string }) => Promise<unknown>;
}

export function createSignOutHandler(deps: SignOutDeps): () => Promise<Response> {
  return async () => {
    // With redirect on (the default), Auth.js hands Next a redirect to
    // throw, so the handler only returns when a test has given it a
    // signOut that resolves instead.
    await deps.signOut({ redirectTo: '/sign-in' });
    return Response.redirect(
      new URL('/sign-in', process.env['AUTH_URL'] ?? 'http://localhost:3000'),
      303,
    );
  };
}

export const POST = createSignOutHandler({ signOut });
