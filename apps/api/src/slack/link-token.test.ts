import { describe, expect, it } from 'vitest';
import {
  deriveLinkKey,
  linkTokenMatches,
  newLinkNonce,
  parseLinkToken,
  signLinkToken,
} from './link-token.js';

const key = deriveLinkKey('slack-signing-secret-for-tests');
const ids = { slackUserId: 'U0TAREK', slackTeamId: 'T0VALLIANCE' };
const claims = { ...ids, nonce: newLinkNonce(), expiresAtSeconds: 1_790_000_300 };

describe('the /lance login token', () => {
  it('verifies against the Slack ids it was issued for', () => {
    const parsed = parseLinkToken(signLinkToken(key, claims));
    expect(parsed).not.toBeNull();
    expect(parsed === null ? false : linkTokenMatches(key, parsed, ids)).toBe(true);
  });

  it('names no Slack id in the token itself', () => {
    const token = signLinkToken(key, claims);
    expect(token).not.toContain('U0TAREK');
    expect(token).not.toContain('T0VALLIANCE');
  });

  it('is refused for another Slack user', () => {
    const parsed = parseLinkToken(signLinkToken(key, claims));
    expect(
      parsed === null ? true : linkTokenMatches(key, parsed, { ...ids, slackUserId: 'U0DOM' }),
    ).toBe(false);
  });

  it('is refused when its expiry was moved', () => {
    const token = signLinkToken(key, claims).replace('1790000300', '1790009999');
    const parsed = parseLinkToken(token);
    expect(parsed === null ? true : linkTokenMatches(key, parsed, ids)).toBe(false);
  });

  it('is refused when its MAC was altered', () => {
    const token = signLinkToken(key, claims);
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    const parsed = parseLinkToken(`${token.slice(0, -1)}${last}`);
    expect(parsed === null ? true : linkTokenMatches(key, parsed, ids)).toBe(false);
  });

  it('is refused under another key', () => {
    const parsed = parseLinkToken(signLinkToken(deriveLinkKey('another secret'), claims));
    expect(parsed === null ? true : linkTokenMatches(key, parsed, ids)).toBe(false);
  });

  it('parses nothing that is not a v1 token', () => {
    expect(parseLinkToken('')).toBeNull();
    expect(parseLinkToken('v2.abc.1.def')).toBeNull();
    expect(parseLinkToken(`${signLinkToken(key, claims)}.extra`)).toBeNull();
  });
});
