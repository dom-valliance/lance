import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '../secure-compare.js';

/**
 * Slack request signing, version `v0` (spec 4.1: "signed-request
 * verification on every call"). The base string is
 * `v0:<timestamp>:<raw body>`, HMAC-SHA256 under the signing secret, hex,
 * prefixed `v0=`. The raw body matters: any re-serialisation changes the
 * bytes and the signature no longer matches.
 */

/** Slack's own guidance: reject anything older than five minutes. */
export const REPLAY_WINDOW_SECONDS = 60 * 5;

export interface SlackSignatureInput {
  signingSecret: string;
  /** The `x-slack-request-timestamp` header: Unix seconds, as sent. */
  timestamp: string;
  /** The request body exactly as received. */
  body: string;
  /** The `x-slack-signature` header, including the `v0=` prefix. */
  signature: string;
  /** Injected in tests. Defaults to the system clock. */
  now?: Date;
}

export type SlackVerification = { ok: true } | { ok: false; reason: string };

export const slackSignature = (signingSecret: string, timestamp: string, body: string): string =>
  `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex')}`;

export const verifySlackSignature = (input: SlackSignatureInput): SlackVerification => {
  if (input.timestamp.length === 0) {
    return { ok: false, reason: 'the x-slack-request-timestamp header is missing' };
  }
  if (input.signature.length === 0) {
    return { ok: false, reason: 'the x-slack-signature header is missing' };
  }

  const sentAtSeconds = Number(input.timestamp);
  if (!Number.isFinite(sentAtSeconds)) {
    return { ok: false, reason: 'the x-slack-request-timestamp header is not Unix seconds' };
  }

  const now = input.now ?? new Date();
  const ageSeconds = Math.abs(now.getTime() / 1000 - sentAtSeconds);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return {
      ok: false,
      reason: `the request timestamp is outside the ${String(REPLAY_WINDOW_SECONDS)} second replay window`,
    };
  }

  const expected = slackSignature(input.signingSecret, input.timestamp, input.body);
  if (!constantTimeEquals(expected, input.signature)) {
    return { ok: false, reason: 'the signature does not match the request body' };
  }

  return { ok: true };
};
