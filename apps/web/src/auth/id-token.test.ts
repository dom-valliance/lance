import { describe, expect, it } from 'vitest';
import { idTokenFromJwt } from './id-token';
import { sessionFromToken } from './session';

describe('the session a browser can read', () => {
  it('never carries the Entra id token', () => {
    const session = sessionFromToken(
      { expires: '2026-09-25T10:00:00.000Z' },
      { idToken: 'a-raw-entra-id-token', roles: ['Lance.User'], oid: 'an-oid' },
    );

    expect(JSON.stringify(session)).not.toContain('a-raw-entra-id-token');
    expect(session.roles).toEqual(['Lance.User']);
    expect(session.oid).toBe('an-oid');
  });

  it('carries the renewal error and nothing else once renewal has failed', () => {
    const session = sessionFromToken(
      { expires: '2026-09-25T10:00:00.000Z' },
      { idToken: 'a-raw-entra-id-token', error: 'RefreshTokenError' },
    );

    expect(session.error).toBe('RefreshTokenError');
    expect(JSON.stringify(session)).not.toContain('a-raw-entra-id-token');
  });
});

describe('idTokenFromJwt', () => {
  it('reads the id token from the server-side JWT', () => {
    expect(idTokenFromJwt({ idToken: 'a-raw-entra-id-token' })).toBe('a-raw-entra-id-token');
  });

  it('gives nothing when renewal failed or there is no JWT', () => {
    expect(idTokenFromJwt({ idToken: 'stale', error: 'RefreshTokenError' })).toBeUndefined();
    expect(idTokenFromJwt(null)).toBeUndefined();
    expect(idTokenFromJwt({})).toBeUndefined();
  });
});
