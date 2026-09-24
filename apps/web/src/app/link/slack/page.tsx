import { auth } from '@/auth';
import { Wordmark } from '@/components/shell/wordmark';
import { SubmitButton } from '@/components/submit-button';
import type { SearchParams } from '@/lib/filters';
import { previewMessage } from '@/lib/slack-link-view';
import { apiClient } from '@/lib/trpc';
import { signInToLinkAction } from './actions';
import { ConfirmForm } from './confirm-form';
import { LinkMessageView } from './link-message';

/**
 * Where a `/lance login` link lands (ADR 0021). The person signs in with
 * Entra, role-gated as every sign-in is (ADR 0020), sees which Slack
 * account the link names, and confirms. The api binds the two and records
 * both steps in the ledger.
 *
 * `state` is the one query parameter read, and it is a credential for one
 * binding, not a message: every outcome shown here comes from the api, and
 * no outcome or error is ever put in the URL. The page sits outside the
 * sign-in proxy so that it can send a signed-out visitor to Microsoft and
 * straight back here, and so an onboarding principal, for whom linking
 * Slack is an onboarding step, reaches it.
 */

const CARD = 'mx-auto flex w-full max-w-[420px] flex-col gap-5 rounded-xl bg-card p-8';

function agentDisplayName(): string {
  return process.env['AGENT_DISPLAY_NAME'] ?? 'Lance';
}

export default async function LinkSlackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const name = agentDisplayName();
  const params = await searchParams;
  const raw = params['state'];
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? '';

  if (token === '') {
    return (
      <div className={CARD}>
        <Wordmark name={name} className="h-6" />
        <LinkMessageView
          message={{
            heading: 'This link is incomplete',
            body: 'Run /lance login in Slack and follow the link it gives you.',
            tone: 'failure',
          }}
        />
      </div>
    );
  }

  const session = await auth();
  if (session === null || session.error !== undefined || session.idToken === undefined) {
    return (
      <div className={CARD}>
        <Wordmark name={name} className="h-6" />
        <h1 className="text-xl font-semibold">Link your Slack account</h1>
        <p className="text-sm text-muted-foreground">
          Sign in with your Valliance Microsoft account to link the Slack account that asked for
          this link. You will come straight back here.
        </p>
        <form action={signInToLinkAction}>
          <input type="hidden" name="token" value={token} />
          <SubmitButton size="lg" className="w-full" pendingLabel="Redirecting">
            Continue with Microsoft
          </SubmitButton>
        </form>
      </div>
    );
  }

  const client = await apiClient();
  const [preview, current] = await Promise.all([
    client.slackLink.preview.query({ token }),
    client.slackLink.current.query(),
  ]);
  const message = previewMessage(preview, current, name);

  return (
    <div className={CARD}>
      <Wordmark name={name} className="h-6" />
      {preview.status === 'ready' ? (
        <>
          <LinkMessageView message={message} />
          <ConfirmForm token={token} agentName={name} />
        </>
      ) : (
        <LinkMessageView message={message} />
      )}
    </div>
  );
}
