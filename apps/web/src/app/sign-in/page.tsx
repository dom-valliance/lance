import { signIn, signOut } from '@/auth';
import { Wordmark } from '@/components/shell/wordmark';
import { SubmitButton } from '@/components/submit-button';
import type { SearchParams } from '@/lib/filters';

/**
 * The only page a signed-out visitor can reach (design 7.12). The shell
 * renders it centred on an empty canvas: no sidebar, no top bar, no
 * status, because none of that is readable without a session.
 */

const CARD = 'mx-auto flex w-full max-w-[360px] flex-col gap-5 rounded-xl bg-card p-8';

/** Auth.js sends a refused sign-in here with `?error=AccessDenied`. */
const ACCESS_DENIED = 'AccessDenied';

function agentDisplayName(): string {
  return process.env['AGENT_DISPLAY_NAME'] ?? 'Lance';
}

async function continueWithMicrosoft(): Promise<void> {
  'use server';
  await signIn('microsoft-entra-id', { redirectTo: '/today' });
}

async function signOutAndRetry(): Promise<void> {
  'use server';
  await signOut({ redirectTo: '/sign-in' });
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  // The one query parameter this app reads for anything but a filter.
  // It is not a message: Auth.js owns both the redirect and the code, and
  // the codes are a fixed vocabulary of its own ("AccessDenied",
  // "Configuration"). The sentences below are written here and chosen from
  // that code, so nothing user-facing travels in the URL and the rule in
  // the root CLAUDE.md holds. A server action still answers through
  // `useActionState`, never through a redirect.
  const raw = params['error'];
  const errorCode = Array.isArray(raw) ? raw[0] : raw;

  if (errorCode === ACCESS_DENIED) {
    return (
      <div className={CARD}>
        <Wordmark name={agentDisplayName()} className="h-6" />
        <h1 className="text-xl font-semibold">This account has no Lance access</h1>
        <p role="alert" className="text-[13px] text-sem-red-fg">
          Access comes from the Lance Users group in Entra. Ask a Lance admin to add you, then sign
          in again. Nothing was recorded.
        </p>
        <form action={signOutAndRetry}>
          <SubmitButton variant="outline" size="lg" className="w-full" pendingLabel="Signing out">
            Sign out and try another account
          </SubmitButton>
        </form>
      </div>
    );
  }

  const failed = errorCode !== undefined && errorCode !== '';

  return (
    <div className={CARD}>
      <Wordmark name={agentDisplayName()} className="h-6" />
      <h1 className="text-xl font-semibold">
        {failed ? 'Sign-in did not complete' : 'Sign in with your Valliance account'}
      </h1>
      {failed ? (
        <p role="alert" className="text-[13px] text-sem-red-fg">
          Microsoft did not finish the sign-in. Try again.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Lance is open to members of the Lance Users group. You will be sent to Microsoft and back.
        </p>
      )}
      <form action={continueWithMicrosoft}>
        <SubmitButton size="lg" className="w-full" pendingLabel="Redirecting">
          <MicrosoftGlyph />
          Continue with Microsoft
        </SubmitButton>
      </form>
    </div>
  );
}

/** The four-square Microsoft mark. Lucide has no brand glyphs, so it is inline. */
function MicrosoftGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="7" height="7" fill="#f25022" />
      <rect x="9" y="0" width="7" height="7" fill="#7fba00" />
      <rect x="0" y="9" width="7" height="7" fill="#00a4ef" />
      <rect x="9" y="9" width="7" height="7" fill="#ffb900" />
    </svg>
  );
}
