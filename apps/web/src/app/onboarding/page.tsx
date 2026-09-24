import { SIGN_OUT_PATH } from '@/components/shell/nav';
import { Wordmark } from '@/components/shell/wordmark';
import { Button } from '@/components/ui/button';

/**
 * Where a principal in status onboarding lands (ADR 0020). The shell
 * renders it centred with no navigation, because every other page and
 * every api procedure but `me` refuses them. Package 5.5 replaces this
 * with the onboarding checklist.
 */

const CARD = 'mx-auto flex w-full max-w-[360px] flex-col gap-5 rounded-xl bg-card p-8';

function agentDisplayName(): string {
  return process.env['AGENT_DISPLAY_NAME'] ?? 'Lance';
}

export default function OnboardingPage() {
  const name = agentDisplayName();
  return (
    <div className={CARD}>
      <Wordmark name={name} className="h-6" />
      <h1 className="text-xl font-semibold">Onboarding is not open yet</h1>
      <p className="text-sm text-muted-foreground">
        Your account has access to {name}, and you are on the list. Setting up your own mail,
        meetings and tasks opens soon; until then there is nothing else here to use.
      </p>
      <form action={SIGN_OUT_PATH} method="post">
        <Button type="submit" variant="outline" size="lg" className="w-full">
          Sign out
        </Button>
      </form>
    </div>
  );
}
