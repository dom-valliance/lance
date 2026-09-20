import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import {
  fakeDeps,
  fakeSnapshot,
  TEST_SIGNING_SECRET,
  TEST_SLACK_USER_ID,
  type FakeDeps,
} from '../test-fakes.js';
import { slackSignature } from './verify.js';

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

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

describe('the commands that arrive in a later phase', () => {
  it('says so for brief', async () => {
    expect(await slashText('brief')).toBe(
      'The brief command arrives in a later phase. No brief has been generated.',
    );
  });

  it('says so for task', async () => {
    expect(await slashText('task ring the accountant')).toBe(
      'The task command arrives in a later phase. No task has been created.',
    );
  });

  it('says so for chase', async () => {
    expect(await slashText('chase 01K5S9V6QW3SWCCPVB0N0E301A')).toBe(
      'The chase command arrives in a later phase. No chase has been drafted.',
    );
  });
});

describe('an unrecognised slash command', () => {
  it('replies with the usage line', async () => {
    expect(await slashText('sing')).toBe(
      'Usage: /lance status | pause [reason] | resume | brief | task <text> | chase <commitment id>',
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
  it('acknowledges a block action with 200', async () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      actions: [{ action_id: 'proposal_approve' }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const response = await post('/slack/interactions', body, FORM);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
