import { describe, expect, it } from 'vitest';
import {
  CONTINUE_PATH,
  missingLine,
  onboardingRedirect,
  progressLine,
  readPreferencesForm,
  stepViews,
  type OnboardingState,
} from './onboarding-view';

const fresh = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  status: 'onboarding',
  notice: { done: false, acceptedAt: null, changedSinceAcceptance: false },
  graph: { done: false, connectedAt: null },
  jamie: { done: false, connectedAt: null },
  foundry: { required: false, arrivesLater: true },
  slack: { done: false, linkedAt: null },
  preferences: {
    done: false,
    confirmedAt: null,
    timeZone: 'Europe/London',
    quietHoursStart: '19:00',
    quietHoursEnd: '07:00',
    source: 'defaults',
  },
  missing: ['notice', 'graph', 'jamie', 'slack', 'preferences'],
  ...overrides,
});

const statusOf = (state: OnboardingState, key: string) =>
  stepViews(state, 'Lance').find((step) => step.key === key);

describe('stepViews', () => {
  it('lists the six steps in order, with Foundry arriving later', () => {
    const steps = stepViews(fresh(), 'Lance');
    expect(steps.map((step) => [step.number, step.key, step.status])).toEqual([
      [1, 'notice', 'to_do'],
      [2, 'graph', 'to_do'],
      [3, 'jamie', 'to_do'],
      [4, 'foundry', 'later'],
      [5, 'slack', 'to_do'],
      [6, 'preferences', 'to_do'],
    ]);
    expect(steps[3]?.badge).toEqual({ label: 'Arrives later', tone: 'neutral' });
  });

  it('marks a step done from the server state and says when, in London', () => {
    const state = fresh({
      graph: { done: true, connectedAt: '2026-09-28T09:00:00.000Z' },
      missing: ['notice', 'jamie', 'slack', 'preferences'],
    });
    expect(statusOf(state, 'graph')).toMatchObject({
      status: 'done',
      badge: { label: 'Done', tone: 'green' },
      summary: 'Connected on 28 September 2026 at 10:00.',
    });
  });

  it('asks again, and says why, when the notice changed after it was accepted', () => {
    const state = fresh({
      notice: { done: false, acceptedAt: null, changedSinceAcceptance: true },
    });
    expect(statusOf(state, 'notice')).toMatchObject({
      status: 'to_do',
      summary:
        'The notice has changed since you accepted it. Read it again and accept this version.',
    });
  });

  it('shows the quiet hours as waiting while the worker reads the mailbox', () => {
    const state = fresh({
      graph: { done: true, connectedAt: '2026-09-28T09:00:00.000Z' },
      preferences: { ...fresh().preferences, source: 'waiting_for_mailbox' },
    });
    expect(statusOf(state, 'preferences')).toMatchObject({
      status: 'waiting',
      badge: { label: 'Waiting', tone: 'blue' },
    });
  });

  it('says the quiet hours came from Outlook once they did', () => {
    const state = fresh({ preferences: { ...fresh().preferences, source: 'mailbox' } });
    expect(statusOf(state, 'preferences')?.summary).toContain(
      'Read from your Outlook working hours',
    );
  });
});

describe('progress and what is missing', () => {
  it('counts the five required steps', () => {
    expect(progressLine(fresh())).toBe('0 of 5 required steps done');
    expect(progressLine(fresh({ missing: ['slack'] }))).toBe('4 of 5 required steps done');
  });

  it('names what is left, and nothing once every step is done', () => {
    expect(missingLine(fresh({ missing: ['jamie', 'slack'] }))).toBe(
      'To finish, add your Jamie API key and link Slack.',
    );
    expect(missingLine(fresh({ missing: [] }))).toBeNull();
  });
});

describe('onboardingRedirect', () => {
  it('keeps an onboarding principal on the checklist', () => {
    expect(onboardingRedirect('onboarding')).toBeNull();
  });

  it('sends an active principal away, through the route that renews their session', () => {
    expect(onboardingRedirect('active')).toBe(CONTINUE_PATH);
    expect(onboardingRedirect('paused')).toBe(CONTINUE_PATH);
  });
});

describe('readPreferencesForm', () => {
  const form = (values: Record<string, string>): FormData => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };

  it('reads a time zone and two times', () => {
    expect(
      readPreferencesForm(
        form({ timeZone: ' Europe/Paris ', quietHoursStart: '20:00', quietHoursEnd: '06:30' }),
      ),
    ).toEqual({
      ok: true,
      value: { timeZone: 'Europe/Paris', quietHoursStart: '20:00', quietHoursEnd: '06:30' },
    });
  });

  it('refuses a time zone that does not exist, saying what one looks like', () => {
    expect(
      readPreferencesForm(
        form({ timeZone: 'Paris', quietHoursStart: '20:00', quietHoursEnd: '06:30' }),
      ),
    ).toEqual({
      ok: false,
      failure: 'Time zone must be a zone name such as Europe/London. Nothing was saved.',
    });
  });

  it('refuses a time that is not HH:MM', () => {
    const read = readPreferencesForm(
      form({ timeZone: 'UTC', quietHoursStart: '7pm', quietHoursEnd: '06:30' }),
    );
    expect(read).toMatchObject({ ok: false });
  });
});
