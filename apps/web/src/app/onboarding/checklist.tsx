import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ExternalLink } from 'lucide-react';
import { ActionForm } from '@/components/action-form';
import { Markdown } from '@/components/markdown';
import { SIGN_OUT_PATH } from '@/components/shell/nav';
import { Wordmark } from '@/components/shell/wordmark';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  missingLine,
  progressLine,
  stepViews,
  type OnboardingState,
  type StepView,
} from '@/lib/onboarding-view';
import {
  acceptNoticeAction,
  completeOnboardingAction,
  confirmPreferencesAction,
  saveJamieKeyAction,
} from './actions';

/**
 * The onboarding checklist as the eye sees it (docs/plans/multi-user.md
 * M3): one card per step in a single column, each with its number, title,
 * a worded badge and a sentence saying where it stands, then the control
 * that moves it on. Built from the existing components only, with no
 * design of its own yet, so it restyles in one place.
 */

const STEP_CARD = 'flex flex-col gap-4 rounded-xl bg-card p-5 sm:p-6';
const SUBMIT = 'h-11 self-start lg:h-9';

function StepCard({ view, children }: { view: StepView; children?: ReactNode }) {
  return (
    <li className={STEP_CARD} aria-labelledby={`step-${view.key}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold',
            view.status === 'done'
              ? 'border-sem-green-line bg-sem-green-bg text-sem-green-fg'
              : 'border-input text-muted-foreground',
          )}
        >
          {view.number}
        </span>
        <h2 id={`step-${view.key}`} className="min-w-0 flex-1 text-base font-semibold">
          <span className="sr-only">Step {view.number}: </span>
          {view.title}
        </h2>
        <Badge tone={view.badge.tone}>{view.badge.label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{view.summary}</p>
      {children}
    </li>
  );
}

function NoticeStep({ view, markdown }: { view: StepView; markdown: string }) {
  if (view.status === 'done') {
    return (
      <StepCard view={view}>
        <details className="text-sm">
          <summary className="cursor-pointer text-brand">Read the notice again</summary>
          <Markdown source={markdown} className="mt-3" />
        </details>
      </StepCard>
    );
  }
  return (
    <StepCard view={view}>
      <div
        className="max-h-80 overflow-y-auto rounded-lg border border-input p-4"
        tabIndex={0}
        role="region"
        aria-label="Data-processing notice"
      >
        <Markdown source={markdown} />
      </div>
      <ActionForm action={acceptNoticeAction} className="flex flex-col gap-2">
        <SubmitButton pendingLabel="Recording" className={SUBMIT}>
          I have read the notice and accept it
        </SubmitButton>
      </ActionForm>
    </StepCard>
  );
}

function GraphStep({ view }: { view: StepView }) {
  return (
    <StepCard view={view}>
      {view.status === 'done' ? null : (
        <div className="flex flex-col gap-2">
          <a
            href="/api/graph/connect"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ size: 'lg' }), 'self-start lg:h-9')}
          >
            <ExternalLink aria-hidden />
            Connect Microsoft 365
          </a>
          <p className="text-xs text-muted-foreground">
            Microsoft&apos;s consent page opens in a new tab. When it says you are connected, close
            that tab and reload this page.
          </p>
        </div>
      )}
    </StepCard>
  );
}

function JamieStep({ view }: { view: StepView }) {
  return (
    <StepCard view={view}>
      {view.status === 'done' ? null : (
        <ActionForm action={saveJamieKeyAction} className="flex flex-col gap-3">
          <Field
            label="Jamie API key"
            hint="In Jamie, open Settings, Developers, API Keys and create a personal key. A workspace key cannot read your meetings."
          >
            <Input
              type="password"
              name="apiKey"
              autoComplete="off"
              spellCheck={false}
              required
              className="h-11 lg:h-9"
            />
          </Field>
          <SubmitButton pendingLabel="Testing the key" className={SUBMIT}>
            Test and save the key
          </SubmitButton>
        </ActionForm>
      )}
    </StepCard>
  );
}

function SlackStep({ view }: { view: StepView }) {
  return (
    <StepCard view={view}>
      {view.status === 'done' ? null : (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>
            In Slack, send <code className="rounded bg-muted px-1 font-mono">/lance login</code>.
          </li>
          <li>Follow the link it gives you, sign in with Microsoft and confirm.</li>
          <li>Come back and reload this page.</li>
        </ol>
      )}
    </StepCard>
  );
}

function PreferencesStep({ view, state }: { view: StepView; state: OnboardingState }) {
  const { preferences } = state;
  return (
    <StepCard view={view}>
      <ActionForm action={confirmPreferencesAction} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Time zone" hint="For example Europe/London.">
            <Input
              name="timeZone"
              defaultValue={preferences.timeZone}
              autoComplete="off"
              spellCheck={false}
              required
              className="h-11 lg:h-9"
            />
          </Field>
          <Field label="Quiet from">
            <Input
              type="time"
              name="quietHoursStart"
              defaultValue={preferences.quietHoursStart}
              required
              className="h-11 lg:h-9"
            />
          </Field>
          <Field label="Quiet until">
            <Input
              type="time"
              name="quietHoursEnd"
              defaultValue={preferences.quietHoursEnd}
              required
              className="h-11 lg:h-9"
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          In quiet hours nothing is posted to you but urgent alerts.
        </p>
        <SubmitButton pendingLabel="Saving" className={SUBMIT}>
          {view.status === 'done' ? 'Save changes' : 'Confirm'}
        </SubmitButton>
      </ActionForm>
    </StepCard>
  );
}

function FinishCard({ state, agentName }: { state: OnboardingState; agentName: string }) {
  const missing = missingLine(state);
  return (
    <section className={STEP_CARD} aria-labelledby="finish">
      <h2 id="finish" className="text-base font-semibold">
        Finish onboarding
      </h2>
      <p className="text-sm text-muted-foreground">
        {agentName} starts in dry run: it watches, proposes and records, and writes nothing to your
        mail, Notion or Slack. You can switch to live from Settings five working days after you
        finish.
      </p>
      <ActionForm action={completeOnboardingAction} className="flex flex-col gap-2">
        {missing === null ? null : <p className="text-sm">{missing}</p>}
        <SubmitButton
          size="lg"
          pendingLabel="Opening"
          disabled={missing !== null}
          className="self-start lg:h-9"
        >
          Open {agentName}
        </SubmitButton>
      </ActionForm>
    </section>
  );
}

/** The checklist itself, from the api's state; the page reads the state and renders this. */
export function OnboardingChecklist({
  state,
  noticeMarkdown,
  agentName,
}: {
  state: OnboardingState;
  noticeMarkdown: string;
  agentName: string;
}) {
  const views = stepViews(state, agentName);
  const view = (key: StepView['key']): StepView => {
    const found = views.find((candidate) => candidate.key === key);
    if (found === undefined) throw new Error(`The onboarding checklist has no step "${key}".`);
    return found;
  };
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 py-4">
      <header className="flex flex-col gap-3">
        <Wordmark name={agentName} className="h-6 self-start" />
        <h1 className="text-2xl font-semibold">Set up {agentName}</h1>
        <p className="text-sm text-muted-foreground">
          These steps connect {agentName} to your own mail, meetings and Slack. Each one is saved as
          you go, so you can leave and come back.
        </p>
        <p className="text-sm font-medium">{progressLine(state)}</p>
      </header>

      <ol className="flex flex-col gap-4">
        <NoticeStep view={view('notice')} markdown={noticeMarkdown} />
        <GraphStep view={view('graph')} />
        <JamieStep view={view('jamie')} />
        <StepCard view={view('foundry')} />
        <SlackStep view={view('slack')} />
        <PreferencesStep view={view('preferences')} state={state} />
      </ol>

      <FinishCard state={state} agentName={agentName} />

      <form action={SIGN_OUT_PATH} method="post" className="self-start">
        <Button type="submit" variant="outline" size="lg" className="lg:h-9">
          Sign out
        </Button>
      </form>
    </div>
  );
}
