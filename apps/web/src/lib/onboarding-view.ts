import type { Tone } from '@/lib/tones';
import type { ApiClient } from '@/lib/trpc';

/**
 * What the onboarding checklist says (docs/plans/multi-user.md M3). The api
 * decides each step's state; this module words it, so every state is
 * tested without a render.
 */

export type OnboardingState = Awaited<ReturnType<ApiClient['onboarding']['state']['query']>>;
export type RequiredStep = OnboardingState['missing'][number];

export type StepKey = 'notice' | 'graph' | 'jamie' | 'foundry' | 'slack' | 'preferences';

export type StepStatus = 'done' | 'to_do' | 'waiting' | 'later';

export interface StepView {
  key: StepKey;
  number: number;
  title: string;
  status: StepStatus;
  /** The badge beside the title: always a word, never colour alone. */
  badge: { label: string; tone: Tone };
  /** One sentence under the title saying where the step stands. */
  summary: string;
}

/** Where the continue route sends a principal whose onboarding is over. */
export const CONTINUE_PATH = '/onboarding/continue';

const BADGES: Record<StepStatus, { label: string; tone: Tone }> = {
  done: { label: 'Done', tone: 'green' },
  to_do: { label: 'To do', tone: 'peach' },
  waiting: { label: 'Waiting', tone: 'blue' },
  later: { label: 'Arrives later', tone: 'neutral' },
};

const STEP_NAMES: Record<RequiredStep, string> = {
  notice: 'accept the data-processing notice',
  graph: 'connect Microsoft 365',
  jamie: 'add your Jamie API key',
  slack: 'link Slack',
  preferences: 'confirm your quiet hours and time zone',
};

const LONDON_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const LONDON_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "28 September 2026 at 10:00", in London. */
export function onDate(iso: string): string {
  const date = new Date(iso);
  return `${LONDON_DATE.format(date)} at ${LONDON_TIME.format(date)}`;
}

const step = (
  key: StepKey,
  number: number,
  title: string,
  status: StepStatus,
  summary: string,
): StepView => ({ key, number, title, status, badge: BADGES[status], summary });

/** The six steps in order, each with its state as the api reported it. */
export function stepViews(state: OnboardingState, agentName: string): StepView[] {
  const { notice, graph, jamie, slack, preferences } = state;
  return [
    step(
      'notice',
      1,
      'Read the data-processing notice',
      notice.done ? 'done' : 'to_do',
      notice.done && notice.acceptedAt !== null
        ? `Accepted on ${onDate(notice.acceptedAt)}.`
        : notice.changedSinceAcceptance
          ? 'The notice has changed since you accepted it. Read it again and accept this version.'
          : `How ${agentName} uses your data, and what it keeps. Read it and accept it to go on.`,
    ),
    step(
      'graph',
      2,
      'Connect Microsoft 365',
      graph.done ? 'done' : 'to_do',
      graph.done && graph.connectedAt !== null
        ? `Connected on ${onDate(graph.connectedAt)}.`
        : `Lets ${agentName} read your mail and calendar and prepare drafts for your approval. It cannot send mail.`,
    ),
    step(
      'jamie',
      3,
      'Add your Jamie API key',
      jamie.done ? 'done' : 'to_do',
      jamie.done && jamie.connectedAt !== null
        ? `Stored on ${onDate(jamie.connectedAt)}. The key is kept in Key Vault and is never shown again.`
        : `Lets ${agentName} read your meetings, transcripts and action items. Jamie is read only, so nothing is written back.`,
    ),
    step(
      'foundry',
      4,
      'Connect Foundry',
      'later',
      'Not needed to finish onboarding. Connecting Foundry arrives in a later release.',
    ),
    step(
      'slack',
      5,
      'Link Slack',
      slack.done ? 'done' : 'to_do',
      slack.done && slack.linkedAt !== null
        ? `Linked on ${onDate(slack.linkedAt)}. Your private channel is where ${agentName} posts to you.`
        : `Proves which Slack account is yours, so ${agentName} can post to you in a private channel of your own.`,
    ),
    step(
      'preferences',
      6,
      'Confirm quiet hours and time zone',
      preferences.done
        ? 'done'
        : preferences.source === 'waiting_for_mailbox'
          ? 'waiting'
          : 'to_do',
      preferencesSummary(preferences, agentName),
    ),
  ];
}

function preferencesSummary(
  preferences: OnboardingState['preferences'],
  agentName: string,
): string {
  switch (preferences.source) {
    case 'confirmed':
      return preferences.confirmedAt === null
        ? 'Confirmed.'
        : `Confirmed on ${onDate(preferences.confirmedAt)}. Change them here or later in Settings.`;
    case 'mailbox':
      return `Read from your Outlook working hours. ${agentName} stays quiet outside them; confirm or change them.`;
    case 'waiting_for_mailbox':
      return 'Reading your Outlook working hours. Reload in a minute, or set them yourself now.';
    case 'defaults':
      return `${agentName}'s defaults. Connect Microsoft 365 to fill these from your working hours, or set them yourself.`;
  }
}

/** "3 of 5 required steps done". */
export function progressLine(state: OnboardingState): string {
  const required = 5;
  const done = required - state.missing.length;
  return `${String(done)} of ${String(required)} required steps done`;
}

/** What the finish control says while steps are missing. */
export function missingLine(state: OnboardingState): string | null {
  if (state.missing.length === 0) return null;
  const names = state.missing.map((key) => STEP_NAMES[key]);
  const last = names.pop();
  const list = names.length === 0 ? (last ?? '') : `${names.join(', ')} and ${last ?? ''}`;
  return `To finish, ${list}.`;
}

/**
 * Where the page sends a principal the api no longer counts as onboarding.
 * The continue route renews the session's status first, so the proxy lets
 * them through to the app rather than back here.
 */
export function onboardingRedirect(status: OnboardingState['status']): string | null {
  return status === 'onboarding' ? null : CONTINUE_PATH;
}

/** `HH:MM`, 24-hour, as the api takes it. */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type PreferencesForm =
  | { ok: true; value: { timeZone: string; quietHoursStart: string; quietHoursEnd: string } }
  | { ok: false; failure: string };

const isKnownTimeZone = (name: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

/** Reads step 6's form, refusing with a sentence the principal can act on. */
export function readPreferencesForm(form: FormData): PreferencesForm {
  const read = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const timeZone = read('timeZone');
  const quietHoursStart = read('quietHoursStart');
  const quietHoursEnd = read('quietHoursEnd');
  if (!(timeZone.includes('/') || timeZone === 'UTC') || !isKnownTimeZone(timeZone)) {
    return {
      ok: false,
      failure: 'Time zone must be a zone name such as Europe/London. Nothing was saved.',
    };
  }
  if (!HH_MM.test(quietHoursStart)) {
    return {
      ok: false,
      failure: 'Quiet from must be a time in 24-hour form, such as 19:00. Nothing was saved.',
    };
  }
  if (!HH_MM.test(quietHoursEnd)) {
    return {
      ok: false,
      failure: 'Quiet until must be a time in 24-hour form, such as 07:00. Nothing was saved.',
    };
  }
  return { ok: true, value: { timeZone, quietHoursStart, quietHoursEnd } };
}
