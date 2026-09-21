import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, isRetryableStatus, type ConnectorErrorOptions } from '../core/index.js';

/**
 * OAuth 2.0 authorisation code with PKCE against Entra ID (spec 4.1).
 * Lance acts as Dom with delegated permissions and a rotating refresh
 * token.
 *
 * Written on `fetch` rather than MSAL on purpose: spec 4.2 requires the
 * refresh token to be stored in Key Vault and rotated on every use, and
 * MSAL keeps the refresh token inside its own token cache where the
 * application cannot reach it. The protocol here is four form fields and a
 * SHA-256; a library that hides the one value we must persist is the wrong
 * trade.
 */

const LOGIN_HOST = 'https://login.microsoftonline.com';

/** The connector operation name every token call reports. */
const OPERATION = 'token';

/**
 * Exactly the delegated scopes of spec 4.1 and
 * docs/runbooks/entra-setup.md. `Mail.Send` is absent, and its absence is
 * the second lock behind the policy hard floor on sending mail
 * (non-negotiable 3). Adding it here is a breaking change to the security
 * model, not a feature.
 */
export const GRAPH_SCOPES = [
  'openid',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Calendars.ReadWrite',
  'MailboxSettings.Read',
] as const;

/** The scopes as Entra wants them on the wire: space separated. */
export const GRAPH_SCOPE_STRING: string = GRAPH_SCOPES.join(' ');

export interface GraphTokens {
  accessToken: string;
  /** Entra rotates this on every refresh; the new value must be stored. */
  refreshToken: string;
  expiresAt: Date;
}

export interface AuthorizeUrlOptions {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}

export interface ExchangeCodeOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}

export interface RefreshAccessTokenOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * A refresh that Entra refused outright, almost always `invalid_grant`:
 * the refresh token was revoked, expired or already replaced. The caller
 * raises the P0 `token_refresh_failed` alert (spec 11) and Dom runs the
 * consent flow again; retrying cannot help.
 */
export class TokenRefreshError extends ConnectorError {
  override readonly name = 'TokenRefreshError';
  /** The OAuth error code Entra returned, for example `invalid_grant`. */
  readonly oauthError: string;

  constructor(oauthError: string, status: number, cause?: unknown) {
    super(
      `Microsoft Entra refused the Graph token request with "${oauthError}". The stored refresh token is no longer usable; sign in again at /auth/graph/connect to issue a new one.`,
      {
        connector: 'graph',
        operation: OPERATION,
        status,
        retryable: false,
        ...(cause === undefined ? {} : { cause }),
      },
    );
    this.oauthError = oauthError;
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** 32 random bytes as base64url: 43 characters, inside RFC 7636's 43 to 128. */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

/** Opaque, unguessable value tying a callback back to the request that started it. */
export function generateState(): string {
  return base64Url(randomBytes(32));
}

/** The S256 code challenge for `codeVerifier`, per RFC 7636. */
export function codeChallengeFor(codeVerifier: string): string {
  return base64Url(createHash('sha256').update(codeVerifier).digest());
}

export function tokenEndpoint(tenantId: string): string {
  return `${LOGIN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export function authorizeEndpoint(tenantId: string): string {
  return `${LOGIN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}

/** The URL to send Dom's browser to, to consent once for the scopes above. */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const query = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    response_mode: 'query',
    scope: GRAPH_SCOPE_STRING,
    state: options.state,
    code_challenge: codeChallengeFor(options.codeVerifier),
    code_challenge_method: 'S256',
  });
  return `${authorizeEndpoint(options.tenantId)}?${query.toString()}`;
}

const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const ErrorResponseSchema = z.looseObject({
  error: z.string().min(1),
});

/**
 * Entra's error bodies carry an `error` code and a long
 * `error_description` that repeats request identifiers. Only the code is
 * kept: it is what makes the failure actionable, and it cannot contain a
 * token.
 */
function oauthErrorCode(text: string): string {
  try {
    const parsed = ErrorResponseSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error : 'unknown_error';
  } catch {
    return 'unknown_error';
  }
}

function transportError(cause: unknown): ConnectorError {
  return new ConnectorError(
    `graph ${OPERATION}: network failure or timeout reaching Microsoft Entra (${cause instanceof Error ? cause.name : 'unknown'}).`,
    { connector: 'graph', operation: OPERATION, retryable: true, cause },
  );
}

/**
 * Posts one form-encoded request to the Entra token endpoint. The core
 * `fetchJson` helper sends JSON, which this endpoint does not accept, so
 * the request is built here; the error mapping matches it exactly, and
 * neither the request form nor the response body ever reaches a message.
 */
async function postToken(
  tenantId: string,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<GraphTokens> {
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint(tenantId), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (error) {
    throw transportError(error);
  }

  const text = await response.text();

  if (!response.ok) {
    const code = oauthErrorCode(text);
    if (code === 'invalid_grant') {
      throw new TokenRefreshError(code, response.status);
    }
    const options: ConnectorErrorOptions = {
      connector: 'graph',
      operation: OPERATION,
      status: response.status,
      retryable: isRetryableStatus(response.status),
    };
    throw new ConnectorError(
      `graph ${OPERATION}: Microsoft Entra answered HTTP ${response.status} with "${code}". Check the client id, the client secret and the redirect URI in docs/runbooks/entra-setup.md.`,
      options,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConnectorError(`graph ${OPERATION}: the token response was not JSON.`, {
      connector: 'graph',
      operation: OPERATION,
      status: response.status,
      retryable: false,
      cause: error,
    });
  }

  const result = TokenResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConnectorError(
      `graph ${OPERATION}: the token response was missing access_token, refresh_token or expires_in. Confirm "offline_access" is among the granted scopes.`,
      { connector: 'graph', operation: OPERATION, status: response.status, retryable: false },
    );
  }

  return {
    accessToken: result.data.access_token,
    refreshToken: result.data.refresh_token,
    expiresAt: new Date(Date.now() + result.data.expires_in * 1000),
  };
}

/** Swaps the authorisation code from the callback for the first token pair. */
export async function exchangeCode(options: ExchangeCodeOptions): Promise<GraphTokens> {
  const form = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
    scope: GRAPH_SCOPE_STRING,
  });
  return postToken(options.tenantId, form, options.fetchImpl ?? fetch);
}

/**
 * Trades the stored refresh token for a fresh access token. The returned
 * `refreshToken` is the NEW one: Entra rotates the refresh token on every
 * use, so the old value stops working the moment this resolves and the
 * caller must store the new one before doing anything else (spec 4.2).
 */
export async function refreshAccessToken(options: RefreshAccessTokenOptions): Promise<GraphTokens> {
  const form = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    scope: GRAPH_SCOPE_STRING,
  });
  return postToken(options.tenantId, form, options.fetchImpl ?? fetch);
}
