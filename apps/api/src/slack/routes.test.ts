import { ModeChangeRefusedError } from '@lance/ledger';
import { ACTION, CALLBACK } from '@lance/connectors';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import {
  fakeDeps,
  fakePrincipal,
  fakeSnapshot,
  TEST_COMMITMENT_ID,
  TEST_PRINCIPAL_ID,
  TEST_SIGNING_SECRET,
  TEST_SLACK_TEAM_ID,
  TEST_SLACK_USER_ID,
  type FakeDeps,
} from '../test-fakes.js';
import { slackSignature } from './verify.js';

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';
const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const LOGIN_PROMPT =
  'This Slack account is not linked to Lance. Run /lance login to link it; nothing else works until you do.';

interface PostOptions {
  timestamp?: string;
  signature?: string;
}

let harness: FakeDeps;
let server: FastifyInstance;

const post = async (
  url: string,
  body: string,
  contentType: string,
  options: PostOptions = {},
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> => {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  return server.inject({
    method: 'POST',
    url,
    payload: body,
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature':
        options.signature ?? slackSignature(TEST_SIGNING_SECRET, timestamp, body),
    },
  });
};

const command = (text: string, userId = TEST_SLACK_USER_ID, teamId = TEST_SLACK_TEAM_ID): string =>
  new URLSearchParams({
    command: '/lance',
    text,
    user_id: userId,
    ...(teamId === '' ? {} : { team_id: teamId }),
    channel_id: 'C0BU7P278N5',
    token: 'a-deprecated-verification-token',
  }).toString();

const slashText = async (text: string, userId = TEST_SLACK_USER_ID): Promise<string> => {
  const response = await post('/slack/commands', command(text, userId), FORM);
  expect(response.statusCode).toBe(200);
  const body = response.json<{ response_type: string; text: string }>();
  expect(body.response_type).toBe('ephemeral');
  return body.text;
};

beforeEach(() => {
  harness = fakeDeps();
  server = buildServer(harness.server);
});

afterEach(async () => {
  await server.close();
});

describe('Slack request signing', () => {
  it('accepts a correctly signed slash command', async () => {
    const response = await post('/slack/commands', command('status'), FORM);
    expect(response.statusCode).toBe(200);
  });

  it('gives an unlinked Slack user the login prompt and nothing else', async () => {
    const response = await post('/slack/commands', command('status', 'U0STRANGER'), FORM);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ response_type: 'ephemeral', text: LOGIN_PROMPT });
  });
  it('rejects a slash command whose signature does not match the body', async () => {
    const response = await post('/slack/commands', command('status'), FORM, {
      signature: 'v0=0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toContain('does not match the request body');
  });

  it('rejects a slash command whose timestamp is outside the replay window', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const response = await post('/slack/commands', command('status'), FORM, { timestamp: stale });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toContain('replay window');
  });

  it('rejects an unsigned event callback', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/slack/events',
      payload: JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
      headers: { 'content-type': JSON_TYPE },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('replay protection (ADR 0021)', () => {
  it('refuses the same signed request a second time inside the window', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = command('pause replayed');

    const first = await post('/slack/commands', body, FORM, { timestamp });
    const replay = await post('/slack/commands', body, FORM, { timestamp });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: string }>().error).toContain('already received once');
    expect(harness.control.pauseCalls).toHaveLength(1);
  });

  it('records a signature only once it has verified', async () => {
    await post('/slack/commands', command('status'), FORM, {
      signature: 'v0=0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(harness.replay.seen.size).toBe(0);
  });
});

/** A server over `h` with its own Slack settings, for the cases that change them. */
const serverWith = (h: FakeDeps, slack: Partial<FakeDeps['server']['slack']>): FastifyInstance =>
  buildServer({ ...h.server, slack: { ...h.server.slack, ...slack } });

const signedPost = (instance: FastifyInstance, body: string) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return instance.inject({
    method: 'POST',
    url: '/slack/commands',
    payload: body,
    headers: {
      'content-type': FORM,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': slackSignature(TEST_SIGNING_SECRET, timestamp, body),
    },
  });
};

describe('/lance login', () => {
  it('gives an unlinked Slack user a single-use link, recorded under the admin', async () => {
    const text = await slashText('login', 'U0NEWCOMER');

    expect(text).toContain('Link this Slack account to Lance:');
    expect(text).toContain(
      '<https://web.example.test/link/slack?state=v1.token|open the link page>',
    );
    expect(text).toContain('works once, for you alone');
    expect(harness.links.issued).toEqual([
      {
        slackUserId: 'U0NEWCOMER',
        slackTeamId: TEST_SLACK_TEAM_ID,
        recordFor: expect.objectContaining({ id: TEST_PRINCIPAL_ID }) as unknown,
        actor: 'system:slack-login',
      },
    ]);
  });

  it("records a linked user's request under their own principal", async () => {
    const text = await slashText('login');

    expect(text).toContain('This Slack account is linked to Lance as dom@valliance.ai.');
    expect(harness.links.issued[0]).toMatchObject({
      slackUserId: TEST_SLACK_USER_ID,
      actor: 'user:dom',
    });
  });

  it('issues nothing when Slack names no workspace', async () => {
    const response = await post('/slack/commands', command('login', 'U0NEWCOMER', ''), FORM);
    const text = response.json<{ text: string }>().text;
    expect(text).toContain('did not say which workspace');
    expect(harness.links.issued).toEqual([]);
  });

  it('says so when the api has no web address to link to', async () => {
    harness.links.issueResult = { status: 'unconfigured' };
    expect(await slashText('login', 'U0NEWCOMER')).toContain('PUBLIC_WEB_URL is not set');
  });
});

describe('the SLACK_ALLOWED_USER_ID fallback', () => {
  it('lets Dom act from Slack before he has linked', async () => {
    const unlinked = fakeDeps({ principal: fakePrincipal({ slackUserId: null }) });
    const instance = serverWith(unlinked, { fallbackUserId: 'U0BN7JN7BAN' });
    try {
      const response = await signedPost(instance, command('pause before linking', 'U0BN7JN7BAN'));
      expect(response.json<{ text: string }>().text).toContain('Lance is paused.');
      expect(unlinked.control.pauseCalls).toHaveLength(1);
    } finally {
      await instance.close();
    }
  });

  it('is ignored once Dom has linked, whoever sends it', async () => {
    const linked = fakeDeps({ principal: fakePrincipal({ slackUserId: 'U0DOMLINKED' }) });
    const instance = serverWith(linked, { fallbackUserId: 'U0BN7JN7BAN' });
    try {
      const response = await signedPost(instance, command('pause', 'U0BN7JN7BAN'));
      expect(response.json<{ text: string }>().text).toBe(LOGIN_PROMPT);
      expect(linked.control.pauseCalls).toEqual([]);
    } finally {
      await instance.close();
    }
  });
});

describe('a linked principal who is not active', () => {
  it('can run /lance login and nothing else', async () => {
    const onboarding = fakeDeps({
      principal: fakePrincipal({ status: 'onboarding' }),
    });
    const instance = serverWith(onboarding, {});
    try {
      const status = await signedPost(instance, command('status'));
      const login = await signedPost(instance, command('login'));
      expect(status.json<{ text: string }>().text).toBe(
        'Your Lance account is onboarding, so nothing but /lance login works from Slack yet.',
      );
      expect(login.json<{ text: string }>().text).toContain('open the link page');
    } finally {
      await instance.close();
    }
  });
});

describe('/lance status', () => {
  it('reports paused state, mode, cursors and cost today', async () => {
    harness.status.current = fakeSnapshot({
      paused: true,
      pausedReason: 'deploying the worker',
      pausedBy: 'user:dom',
      pausedAt: '2026-09-20T08:30:00.000Z',
      costTodayGbp: 2.5,
    });

    const text = await slashText('status');

    expect(text).toContain('Lance status');
    expect(text).toContain('Paused: yes. Reason: deploying the worker. By: user:dom.');
    expect(text).toContain('Mode: dry_run.');
    expect(text).toContain('graph-mail (inbox): updated 12 minutes ago.');
    expect(text).toContain('Cost today: GBP 2.50.');
  });
});

describe('/lance pause', () => {
  it('pauses with the supplied reason and says what was held', async () => {
    const text = await slashText('pause deploying the worker');

    expect(harness.control.pauseCalls).toEqual([
      { reason: 'deploying the worker', actor: 'user:dom' },
    ]);
    expect(text).toContain('Lance is paused.');
    expect(text).toContain('Held 1 queued proposals: 01K5S9V6QW3SWCCPVB0N0E301A.');
  });

  it('records a default reason when none is given', async () => {
    await slashText('pause');
    expect(harness.control.pauseCalls).toEqual([
      { reason: 'paused from Slack', actor: 'user:dom' },
    ]);
  });

  it('gives a Slack user with no link the login prompt and pauses nothing', async () => {
    const text = await slashText('pause because I can', 'U0INTRUDER');

    expect(harness.control.pauseCalls).toEqual([]);
    expect(text).toBe(LOGIN_PROMPT);
  });

  it('refuses everyone when no principal has a link', async () => {
    const unconfigured = fakeDeps({ allowedSlackUserId: null });
    const other = buildServer(unconfigured.server);
    try {
      const response = await other.inject({
        method: 'POST',
        url: '/slack/commands',
        payload: command('pause'),
        headers: {
          'content-type': FORM,
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-slack-signature': slackSignature(
            TEST_SIGNING_SECRET,
            String(Math.floor(Date.now() / 1000)),
            command('pause'),
          ),
        },
      });
      expect(response.json<{ text: string }>().text).toBe(LOGIN_PROMPT);
      expect(unconfigured.control.pauseCalls).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe('/lance resume', () => {
  it('resumes and says what was released', async () => {
    harness.control.state = { ...harness.control.state, paused: true };

    const text = await slashText('resume');

    expect(harness.control.resumeCalls).toEqual([{ actor: 'user:dom' }]);
    expect(text).toContain('Lance has resumed.');
    expect(text).toContain('Released 1 held proposals: 01K5S9V6QW3SWCCPVB0N0E301A.');
  });

  it('gives a Slack user with no link the login prompt and resumes nothing', async () => {
    const text = await slashText('resume', 'U0INTRUDER');
    expect(harness.control.resumeCalls).toEqual([]);
    expect(text).toBe(LOGIN_PROMPT);
  });
});

describe('/lance pause all and resume all', () => {
  it('pauses every principal for an admin', async () => {
    const text = await slashText('pause all');
    expect(harness.control.pauseAllCalls).toEqual([
      { reason: 'paused for everyone from Slack', actor: 'user:dom' },
    ]);
    expect(harness.control.pauseCalls).toEqual([]);
    expect(text).toContain('Lance is paused for every principal.');
  });

  it('refuses pause all from a linked principal without Lance.Admin and pauses nothing', async () => {
    const notAdmin = fakeDeps({
      principal: fakePrincipal({ lanceRoles: ['Lance.User'] }),
    });
    const other = buildServer(notAdmin.server);
    try {
      const body = command('pause all');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await other.inject({
        method: 'POST',
        url: '/slack/commands',
        payload: body,
        headers: {
          'content-type': FORM,
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': slackSignature(TEST_SIGNING_SECRET, timestamp, body),
        },
      });
      expect(response.json<{ text: string }>().text).toBe(
        'Only a Lance admin may pause Lance for everyone. /lance pause pauses you alone.',
      );
      expect(notAdmin.control.pauseAllCalls).toEqual([]);
      expect(notAdmin.control.pauseCalls).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('lifts the global pause and says each principal resumes separately', async () => {
    await slashText('pause all');
    const text = await slashText('resume all');
    expect(harness.control.resumeAllCalls).toEqual([{ actor: 'user:dom' }]);
    expect(harness.control.resumeCalls).toEqual([]);
    expect(text).toContain('The pause over every principal is lifted.');
    expect(text).toContain('Resuming each principal is not automatic');
  });
});

describe('/lance jobs, pause <job> and resume <job>', () => {
  it("lists the caller's jobs with their state and next run in London time", async () => {
    const text = await slashText('jobs');
    expect(text).toContain('Your Lance jobs:');
    expect(text).toContain('`alerts-deliver`: on, locked, next run 20 Sept 2026, 10:01');
    expect(text).toContain('`brief-morning`: on, next run 21 Sept 2026, 06:30');
  });

  it('pauses one job and leaves the rest of Lance running', async () => {
    const text = await slashText('pause brief-morning');
    expect(harness.jobs.toggles).toEqual([
      { slug: 'brief-morning', enabled: false, actor: 'user:dom' },
    ]);
    expect(harness.control.pauseCalls).toEqual([]);
    expect(text).toContain('brief-morning is paused');
    expect(await slashText('jobs')).toContain('`brief-morning`: paused, no next run');
  });

  it('refuses to pause a locked job', async () => {
    const text = await slashText('pause alerts-deliver');
    expect(text).toBe(
      'alerts-deliver is locked and cannot be paused. It keeps running whatever else is paused.',
    );
    expect(harness.jobs.jobs.find((job) => job.slug === 'alerts-deliver')?.enabled).toBe(true);
  });

  it('refuses a job name the caller does not have rather than pausing everything', async () => {
    const text = await slashText('pause brief-mornin');
    expect(text).toContain('You have no job called brief-mornin');
    expect(harness.control.pauseCalls).toEqual([]);
  });

  it('resumes a paused job', async () => {
    await slashText('pause brief-morning');
    const text = await slashText('resume brief-morning');
    expect(text).toContain('brief-morning is running again');
    expect(harness.control.resumeCalls).toEqual([]);
  });

  it('gives a Slack user with no link the login prompt instead of the job list', async () => {
    expect(await slashText('jobs', 'U0INTRUDER')).toBe(LOGIN_PROMPT);
  });
});

describe('/lance mode', () => {
  it('reports the current mode when no mode is given', async () => {
    const text = await slashText('mode');
    expect(text).toContain('Lance is in dry_run mode.');
    expect(harness.control.modeCalls).toEqual([]);
  });

  it('switches to live and says how held proposals are released', async () => {
    const text = await slashText('mode live');
    expect(harness.control.modeCalls).toEqual([{ mode: 'live', actor: 'user:dom' }]);
    expect(text).toContain('Lance is now in live mode.');
    expect(text).toContain('/lance pause then /lance resume');
  });

  it('shows the date live opens when a new principal is inside their dry run', async () => {
    harness.control.refuseLive = new ModeChangeRefusedError(
      'Live mode opens on Monday 5 October 2026. A new principal runs in dry run for 5 working days after onboarding.',
      new Date('2026-10-04T23:00:00.000Z'),
    );
    const text = await slashText('mode live');
    expect(text).toContain('Live mode opens on Monday 5 October 2026.');
    expect(harness.control.modeCalls).toEqual([]);
  });

  it('refuses a word that is not a mode', async () => {
    const text = await slashText('mode shadow');
    expect(harness.control.modeCalls).toEqual([]);
    expect(text).toContain('is not a mode');
  });

  it('gives a Slack user with no link the login prompt and changes no mode', async () => {
    const text = await slashText('mode live', 'U0INTRUDER');
    expect(harness.control.modeCalls).toEqual([]);
    expect(text).toBe(LOGIN_PROMPT);
  });
});

describe('/lance brief', () => {
  it('queues a morning brief for Dom and says it is coming', async () => {
    const text = await slashText('brief');
    expect(harness.briefRequests).toHaveLength(1);
    expect(text).toContain('regenerating the morning brief');
  });

  it('gives a Slack user with no link the login prompt and queues no brief', async () => {
    const text = await slashText('brief', 'U0INTRUDER');
    expect(harness.briefRequests).toHaveLength(0);
    expect(text).toBe(LOGIN_PROMPT);
  });
});

describe('the commands that arrive in a later phase', () => {
  it('says so for task', async () => {
    expect(await slashText('task ring the accountant')).toBe(
      'The task command arrives in a later phase. No task has been created.',
    );
  });
});

describe('/lance chase', () => {
  it('enqueues the chase and says a proposal is coming', async () => {
    const text = await slashText(`chase ${TEST_COMMITMENT_ID}`);

    expect(harness.chased).toEqual([TEST_COMMITMENT_ID]);
    expect(text).toBe(
      'Lance is preparing a chase draft for "Send the signed order form". It will arrive here as a proposal for you to approve.',
    );
  });

  it('asks for an id when none was given', async () => {
    expect(await slashText('chase')).toBe(
      'Usage: /lance chase <commitment id>. The id is on the Commitments page.',
    );
    expect(harness.chased).toEqual([]);
  });

  it('says so when the id is not a commitment id at all', async () => {
    expect(await slashText('chase the order form')).toContain('is not a commitment id');
    expect(harness.chased).toEqual([]);
  });

  it('says so when no commitment has that id', async () => {
    expect(await slashText('chase 01K5S9V6QW3SWCCPVB0N0E301A')).toBe(
      'No commitment has id 01K5S9V6QW3SWCCPVB0N0E301A. Check the id on the Commitments page and try again.',
    );
    expect(harness.chased).toEqual([]);
  });

  it('gives a Slack user with no link the login prompt and chases nothing', async () => {
    const text = await slashText(`chase ${TEST_COMMITMENT_ID}`, 'U0INTRUDER');

    expect(text).toBe(LOGIN_PROMPT);
    expect(harness.chased).toEqual([]);
  });
});

describe('an unrecognised slash command', () => {
  it('replies with the usage line', async () => {
    expect(await slashText('sing')).toBe(
      'Usage: /lance login | status | pause [reason | all | <job>] | resume [all | <job>] | jobs | mode [live|dry_run] | brief | task <text> | chase <commitment id>',
    );
  });

  it('replies with the usage line for an empty command', async () => {
    expect(await slashText('')).toContain('Usage: /lance login | status');
  });
});

describe('/slack/events', () => {
  it('answers the url_verification challenge with the challenge value', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'a-slack-challenge' });
    const response = await post('/slack/events', body, JSON_TYPE);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: 'a-slack-challenge' });
  });

  it('acknowledges any other event with 200', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'reaction_added' },
    });
    const response = await post('/slack/events', body, JSON_TYPE);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe('/slack/interactions', () => {
  const interaction = (payload: unknown): string =>
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

  it('applies an approve from Dom and answers with an empty 200', async () => {
    const body = interaction({
      type: 'block_actions',
      user: { id: TEST_SLACK_USER_ID },
      trigger_id: 'T-1',
      actions: [{ action_id: ACTION.proposalApprove, value: PROPOSAL_ID }],
    });

    const response = await post('/slack/interactions', body, FORM);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(harness.decider.requests).toEqual([
      { proposalId: PROPOSAL_ID, action: 'approve', actor: 'user:dom' },
    ]);
  });

  it('gives a block action from a Slack user with no link the login prompt', async () => {
    const body = interaction({
      type: 'block_actions',
      user: { id: 'U0STRANGER' },
      actions: [{ action_id: ACTION.proposalApprove, value: PROPOSAL_ID }],
    });

    const response = await post('/slack/interactions', body, FORM);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ text: string }>().text).toBe(LOGIN_PROMPT);
    expect(harness.decider.requests).toHaveLength(0);
  });

  it('clears the modal after a reject submission', async () => {
    const body = interaction({
      type: 'view_submission',
      user: { id: TEST_SLACK_USER_ID },
      view: {
        callback_id: CALLBACK.proposalReject,
        private_metadata: PROPOSAL_ID,
        state: {
          values: {
            reason_code: {
              reason_code: { type: 'static_select', selected_option: { value: 'not_now' } },
            },
          },
        },
      },
    });

    const response = await post('/slack/interactions', body, FORM);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ response_action: 'clear' });
  });

  it('refuses an unsigned interaction before it reaches the handler', async () => {
    const body = interaction({
      type: 'block_actions',
      user: { id: TEST_SLACK_USER_ID },
      actions: [{ action_id: ACTION.proposalApprove, value: PROPOSAL_ID }],
    });

    const response = await post('/slack/interactions', body, FORM, { signature: 'v0=deadbeef' });

    expect(response.statusCode).toBe(401);
    expect(harness.decider.requests).toHaveLength(0);
  });
});
