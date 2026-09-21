import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/index.js';
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  GRAPH_SCOPE_STRING,
  GRAPH_SCOPES,
  refreshAccessToken,
  TokenRefreshError,
} from './auth.js';
import { graphFixture } from './testing.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const credentials = { tenantId: TENANT, clientId: CLIENT, clientSecret: 'a-client-secret' };

describe('the requested scopes', () => {
  it('does not include Mail.Send, the second lock on sending mail', () => {
    expect(GRAPH_SCOPE_STRING).not.toContain('Mail.Send');
    expect(GRAPH_SCOPES).not.toContain('Mail.Send');
  });

  it('is exactly the list in spec 4.1 and the Entra runbook', () => {
    expect(GRAPH_SCOPE_STRING).toBe(
      'openid offline_access User.Read Mail.ReadWrite Calendars.ReadWrite MailboxSettings.Read',
    );
  });
});

describe('buildAuthorizeUrl', () => {
  const url = new URL(
    buildAuthorizeUrl({
      ...credentials,
      redirectUri: 'https://api.example.com/auth/graph/callback',
      state: 'a-state',
      codeVerifier: 'a-code-verifier',
    }),
  );

  it('points at the tenant authorise endpoint', () => {
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
  });

  it('asks for an authorisation code with an S256 PKCE challenge', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update('a-code-verifier').digest('base64url'),
    );
  });

  it('carries the state, the client id and the redirect URI unchanged', () => {
    expect(url.searchParams.get('state')).toBe('a-state');
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/auth/graph/callback',
    );
  });

  it('requests the six delegated scopes and not Mail.Send', () => {
    expect(url.searchParams.get('scope')).toBe(GRAPH_SCOPE_STRING);
    expect(url.search).not.toContain('Mail.Send');
  });

  it('never sends the verifier itself', () => {
    expect(url.search).not.toContain('a-code-verifier');
  });
});

describe('generateCodeVerifier and generateState', () => {
  it('produces a verifier inside the length RFC 7636 allows', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('produces a different state every time', () => {
    expect(generateState()).not.toBe(generateState());
  });

  it('agrees with the SHA-256 of the verifier it was given', () => {
    const verifier = generateCodeVerifier();
    expect(codeChallengeFor(verifier)).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });
});

describe('exchangeCode', () => {
  it('posts the code and the verifier as a form and returns both tokens', async () => {
    const forms: URLSearchParams[] = [];
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        forms.push(new URLSearchParams(await request.text()));
        return HttpResponse.json(graphFixture<Record<string, unknown>>('token-response'));
      }),
    );

    const tokens = await exchangeCode({
      ...credentials,
      redirectUri: 'https://api.example.com/auth/graph/callback',
      code: 'an-auth-code',
      codeVerifier: 'a-code-verifier',
    });

    const sent = forms[0];
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('code')).toBe('an-auth-code');
    expect(sent?.get('code_verifier')).toBe('a-code-verifier');
    expect(sent?.get('redirect_uri')).toBe('https://api.example.com/auth/graph/callback');
    expect(sent?.get('scope')).toBe(GRAPH_SCOPE_STRING);
    expect(tokens.accessToken).toBe('synthetic-access-token-1');
    expect(tokens.refreshToken).toBe('synthetic-refresh-token-1');
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('refreshAccessToken', () => {
  it('returns the rotated refresh token, not the one it sent', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          ...graphFixture<Record<string, unknown>>('token-response'),
          access_token: 'synthetic-access-token-2',
          refresh_token: 'synthetic-refresh-token-2',
        }),
      ),
    );

    const tokens = await refreshAccessToken({
      ...credentials,
      refreshToken: 'synthetic-refresh-token-1',
    });

    expect(tokens.refreshToken).toBe('synthetic-refresh-token-2');
    expect(tokens.accessToken).toBe('synthetic-access-token-2');
  });

  it('raises a non-retryable TokenRefreshError on invalid_grant', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(graphFixture<Record<string, unknown>>('token-error-invalid-grant'), {
          status: 400,
        }),
      ),
    );

    const error = await refreshAccessToken({
      ...credentials,
      refreshToken: 'a-revoked-refresh-token',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TokenRefreshError);
    const refreshError = error as TokenRefreshError;
    expect(refreshError.retryable).toBe(false);
    expect(refreshError.oauthError).toBe('invalid_grant');
    expect(refreshError.connector).toBe('graph');
    expect(refreshError.operation).toBe('token');
  });

  it('never repeats a token or Entra description in the error message', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(graphFixture<Record<string, unknown>>('token-error-invalid-grant'), {
          status: 400,
        }),
      ),
    );

    const error = (await refreshAccessToken({
      ...credentials,
      refreshToken: 'a-revoked-refresh-token',
    }).catch((caught: unknown) => caught)) as TokenRefreshError;

    expect(error.message).not.toContain('a-revoked-refresh-token');
    expect(error.message).not.toContain('a-client-secret');
    expect(error.message).not.toContain('AADSTS700082');
  });

  it('treats a 5xx from Entra as retryable', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ error: 'temporarily_unavailable' }, { status: 503 }),
      ),
    );

    const error = (await refreshAccessToken({
      ...credentials,
      refreshToken: 'a-refresh-token',
    }).catch((caught: unknown) => caught)) as ConnectorError;

    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).not.toBeInstanceOf(TokenRefreshError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(503);
  });

  it('fails clearly when the response carries no refresh token', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: 'a', expires_in: 3600, token_type: 'Bearer' }),
      ),
    );

    const error = (await refreshAccessToken({
      ...credentials,
      refreshToken: 'a-refresh-token',
    }).catch((caught: unknown) => caught)) as ConnectorError;

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('offline_access');
  });
});
