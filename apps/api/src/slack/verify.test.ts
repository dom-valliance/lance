import { describe, expect, it } from 'vitest';
import { REPLAY_WINDOW_SECONDS, slackSignature, verifySlackSignature } from './verify.js';

const SIGNING_SECRET = 'eight-alphanumeric-characters-and-then-some';
const BODY = 'command=%2Flance&text=status&user_id=U0DOM&channel_id=C0BU7P278N5';
const NOW = new Date('2026-09-20T09:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

const signed = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    timestamp: TIMESTAMP,
    body: BODY,
    signature: slackSignature(SIGNING_SECRET, TIMESTAMP, BODY),
    now: NOW,
    ...overrides,
  });

describe('verifySlackSignature', () => {
  it('accepts a request signed with the signing secret', () => {
    expect(signed()).toEqual({ ok: true });
  });

  it('produces the v0 prefixed hex digest Slack documents', () => {
    expect(slackSignature(SIGNING_SECRET, TIMESTAMP, BODY)).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it('rejects a signature computed over a different body', () => {
    const result = signed({
      signature: slackSignature(SIGNING_SECRET, TIMESTAMP, `${BODY}&injected=1`),
    });
    expect(result).toEqual({ ok: false, reason: 'the signature does not match the request body' });
  });

  it('rejects a signature computed with a different signing secret', () => {
    const result = signed({ signature: slackSignature('a-different-secret', TIMESTAMP, BODY) });
    expect(result.ok).toBe(false);
  });

  it('rejects a correctly signed request older than the replay window', () => {
    const stale = String(Math.floor(NOW.getTime() / 1000) - REPLAY_WINDOW_SECONDS - 1);
    const result = signed({
      timestamp: stale,
      signature: slackSignature(SIGNING_SECRET, stale, BODY),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'the request timestamp is outside the 300 second replay window',
    });
  });

  it('rejects a timestamp far in the future, which is a replay of a clock-skewed capture', () => {
    const ahead = String(Math.floor(NOW.getTime() / 1000) + REPLAY_WINDOW_SECONDS + 1);
    const result = signed({
      timestamp: ahead,
      signature: slackSignature(SIGNING_SECRET, ahead, BODY),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a request with no timestamp header', () => {
    expect(signed({ timestamp: '' })).toEqual({
      ok: false,
      reason: 'the x-slack-request-timestamp header is missing',
    });
  });

  it('rejects a request with no signature header', () => {
    expect(signed({ signature: '' })).toEqual({
      ok: false,
      reason: 'the x-slack-signature header is missing',
    });
  });

  it('rejects a timestamp that is not Unix seconds', () => {
    expect(signed({ timestamp: 'yesterday' })).toEqual({
      ok: false,
      reason: 'the x-slack-request-timestamp header is not Unix seconds',
    });
  });
});
