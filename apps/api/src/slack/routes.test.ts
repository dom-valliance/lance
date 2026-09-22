import { ACTION, CALLBACK } from '@lance/connectors';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import {
  fakeDeps,
  fakeSnapshot,
  TEST_COMMITMENT_ID,
  TEST_SIGNING_SECRET,
  TEST_SLACK_USER_ID,
  type FakeDeps,
} from '../test-fakes.js';
import { slackSignature } from './verify.js';

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';
const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';

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

const command = (text: string, userId = TEST_SLACK_USER_ID): string =>
  new URLSearchParams({
    command: '/lance',
    text,
    user_id: userId,
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
  server = buildServer(harness.deps);
});

afterEach(async () => {
  await server.close();
});

describe('Slack request signing', () => {
  it('accepts a correctly signed slash command', async () => {
    const response = await post('/slack/commands', command('status'), FORM);
    expect(response.statusCode).toBe(200);
  });

  it('refuses status to a Slack user other than Dom', async () => {
    const response = await post('/slack/commands', command('status', 'U0STRANGER'), FORM);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ text: string }>().text).toContain('Dom only');
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

  it('refuses a user who is not on the Slack allowlist', async () => {
    const text = await slashText('pause because I can', 'U0INTRUDER');

    expect(harness.control.pauseCalls).toEqual([]);
    expect(text).toBe(
      'You are not authorised to pause Lance from Slack. Ask Dom, or use the kill switch in Settings.',
    );
  });

  it('refuses everyone when no Slack user id is configured', async () => {
    const unconfigured = fakeDeps({ allowedSlackUserId: null });
    const other = buildServer(unconfigured.deps);
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
      expect(response.json<{ text: string }>().text).toContain('not authorised');
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

  it('refuses a user who is not on the Slack allowlist', async () => {
    const text = await slashText('resume', 'U0INTRUDER');
    expect(harness.control.resumeCalls).toEqual([]);
    expect(text).toContain('not authorised to resume Lance');
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

  it('refuses a word that is not a mode', async () => {
    const text = await slashText('mode shadow');
    expect(harness.control.modeCalls).toEqual([]);
    expect(text).toContain('is not a mode');
  });

  it('refuses a user who is not on the Slack allowlist', async () => {
    const text = await slashText('mode live', 'U0INTRUDER');
    expect(harness.control.modeCalls).toEqual([]);
    expect(text).toContain('Only Dom');
  });
});

describe('/lance brief', () => {
  it('queues a morning brief for Dom and says it is coming', async () => {
    const text = await slashText('brief');
    expect(harness.briefRequests).toHaveLength(1);
    expect(text).toContain('regenerating the morning brief');
  });

  it('refuses a user who is not on the Slack allowlist', async () => {
    const text = await slashText('brief', 'U0INTRUDER');
    expect(harness.briefRequests).toHaveLength(0);
    expect(text).toContain('Only Dom');
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

  it('refuses a Slack user other than Dom', async () => {
    const text = await slashText(`chase ${TEST_COMMITMENT_ID}`, 'U0INTRUDER');

    expect(text).toBe('Only Dom may ask Lance to chase a commitment from Slack.');
    expect(harness.chased).toEqual([]);
  });
});

describe('an unrecognised slash command', () => {
  it('replies with the usage line', async () => {
    expect(await slashText('sing')).toBe(
      'Usage: /lance status | pause [reason] | resume | mode [live|dry_run] | brief | task <text> | chase <commitment id>',
    );
  });

  it('replies with the usage line for an empty command', async () => {
    expect(await slashText('')).toContain('Usage: /lance status');
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

  it('refuses a block action from a Slack user other than Dom', async () => {
    const body = interaction({
      type: 'block_actions',
      user: { id: 'U0STRANGER' },
      actions: [{ action_id: ACTION.proposalApprove, value: PROPOSAL_ID }],
    });

    const response = await post('/slack/interactions', body, FORM);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ text: string }>().text).toContain('not authorised');
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
