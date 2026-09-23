import { describe, expect, it, vi } from 'vitest';
import {
  REFRESH_MARGIN_SECONDS,
  entraTokenEndpoint,
  jwtExpiresAt,
  needsRefresh,
  refreshEntraTokens,
} from './refresh';

function jwtWith(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

const input = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  refreshToken: 'refresh-1',
  scope: 'openid profile email offline_access',
};

function fetchReturning(status: number, body: unknown) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;
}

describe('jwtExpiresAt', () => {
  it('reads the exp claim without verifying the token', () => {
    expect(jwtExpiresAt(jwtWith({ exp: 1_800_000_000, aud: 'x' }))).toBe(1_800_000_000);
  });

  it('returns null for a token that is not a JWT or has no exp', () => {
    expect(jwtExpiresAt('not-a-jwt')).toBeNull();
    expect(jwtExpiresAt(jwtWith({ aud: 'x' }))).toBeNull();
    expect(jwtExpiresAt('a.%%%.c')).toBeNull();
  });
});

describe('needsRefresh', () => {
  const now = Date.UTC(2026, 8, 22, 16, 0, 0);

  it('is false while the token has more than the margin left', () => {
    const expiresAt = Math.floor(now / 1000) + REFRESH_MARGIN_SECONDS + 1;
    expect(needsRefresh(expiresAt, now)).toBe(false);
  });

  it('is true inside the margin, after expiry and when the expiry is unknown', () => {
    expect(needsRefresh(Math.floor(now / 1000) + REFRESH_MARGIN_SECONDS, now)).toBe(true);
    expect(needsRefresh(Math.floor(now / 1000) - 1, now)).toBe(true);
    expect(needsRefresh(null, now)).toBe(true);
    expect(needsRefresh(undefined, now)).toBe(true);
  });
});

describe('refreshEntraTokens', () => {
  it('posts a refresh_token grant to the tenant endpoint and returns the new tokens with the id token expiry', async () => {
    const idToken = jwtWith({ exp: 1_800_003_600 });
    const fetchImpl = fetchReturning(200, {
      id_token: idToken,
      refresh_token: 'refresh-2',
      expires_in: 3600,
    });

    const result = await refreshEntraTokens(input, fetchImpl);

    expect(result).toEqual({ idToken, refreshToken: 'refresh-2', expiresAt: 1_800_003_600 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(entraTokenEndpoint('tenant-1'));
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
    expect(body.get('scope')).toBe(input.scope);
  });

  it('falls back to expires_in when the id token carries no exp, and keeps refreshToken null when none is returned', async () => {
    const now = Date.UTC(2026, 8, 22, 16, 0, 0);
    const fetchImpl = fetchReturning(200, { id_token: jwtWith({ aud: 'x' }), expires_in: 600 });

    const result = await refreshEntraTokens(input, fetchImpl, now);

    expect(result.expiresAt).toBe(Math.floor(now / 1000) + 600);
    expect(result.refreshToken).toBeNull();
  });

  it("throws with Entra's error code when the grant is refused", async () => {
    const fetchImpl = fetchReturning(400, {
      error: 'invalid_grant',
      error_description: 'AADSTS70008: The refresh token has expired.\nTrace ID: abc',
    });

    await expect(refreshEntraTokens(input, fetchImpl)).rejects.toThrow(
      'Entra refused to renew the sign-in (invalid_grant). AADSTS70008: The refresh token has expired.',
    );
  });

  it('throws when the response carries no id token', async () => {
    const fetchImpl = fetchReturning(200, { access_token: 'only-access', expires_in: 3600 });

    await expect(refreshEntraTokens(input, fetchImpl)).rejects.toThrow('without an id token');
  });
});
