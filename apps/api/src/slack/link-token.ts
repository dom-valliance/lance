import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../secure-compare.js';

/**
 * The `/lance login` link token (ADR 0021): `v1.<nonce>.<expiry>.<mac>`.
 * The MAC is HMAC-SHA256 over the version, the Slack user id, the team id,
 * the nonce and the expiry in Unix seconds, so the token names no Slack id
 * in the URL, and a token whose nonce, expiry or ids were changed fails.
 * The nonce is stored in `slack_link_tokens` with the Slack ids; consuming
 * that row is what makes the link work once.
 *
 * The token is a credential for one binding, not user-facing copy: no
 * message, outcome or error ever travels beside it in the URL.
 */

/** Five minutes, as ADR 0021 and the database policy both say. */
export const LINK_TTL_SECONDS = 5 * 60;

const VERSION = 'v1';

/**
 * The link key is derived from the Slack signing secret under a label of
 * its own, so no new secret has to be provisioned and the signing secret
 * is never used directly as a second key. Rotating the signing secret
 * voids links outstanding at the time, which last five minutes at most.
 */
const KEY_LABEL = 'lance:slack-link:v1';

export const deriveLinkKey = (signingSecret: string): Buffer =>
  createHmac('sha256', signingSecret).update(KEY_LABEL, 'utf8').digest();

/** 24 random bytes, 32 characters of base64url. */
export const newLinkNonce = (): string => randomBytes(24).toString('base64url');

export interface LinkClaims {
  slackUserId: string;
  slackTeamId: string;
  nonce: string;
  expiresAtSeconds: number;
}

const macOf = (key: Buffer, claims: LinkClaims): string =>
  createHmac('sha256', key)
    .update(
      [
        VERSION,
        claims.slackUserId,
        claims.slackTeamId,
        claims.nonce,
        String(claims.expiresAtSeconds),
      ].join('\n'),
      'utf8',
    )
    .digest('base64url');

export const signLinkToken = (key: Buffer, claims: LinkClaims): string =>
  `${VERSION}.${claims.nonce}.${String(claims.expiresAtSeconds)}.${macOf(key, claims)}`;

export interface ParsedLinkToken {
  nonce: string;
  expiresAtSeconds: number;
  mac: string;
}

const TOKEN_SHAPE = /^v1\.([A-Za-z0-9_-]{32})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** The token's parts, or null for anything that is not a well-formed v1 token. */
export const parseLinkToken = (token: string): ParsedLinkToken | null => {
  const match = TOKEN_SHAPE.exec(token);
  if (match === null) return null;
  const [, nonce, expiry, mac] = match;
  if (nonce === undefined || expiry === undefined || mac === undefined) return null;
  return { nonce, expiresAtSeconds: Number(expiry), mac };
};

/** Whether the token's MAC covers these Slack ids with its own nonce and expiry. */
export const linkTokenMatches = (
  key: Buffer,
  token: ParsedLinkToken,
  ids: { slackUserId: string; slackTeamId: string },
): boolean =>
  constantTimeEquals(
    macOf(key, { ...ids, nonce: token.nonce, expiresAtSeconds: token.expiresAtSeconds }),
    token.mac,
  );
