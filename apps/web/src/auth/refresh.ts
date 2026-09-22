/**
 * Keeping the Entra id token alive. The api verifies the id token the web
 * forwards as its bearer, and Entra issues that token for about an hour.
 * The Auth.js session cookie lives far longer, so without renewal every
 * page started failing with "the bearer token has expired" an hour after
 * sign-in. The refresh token from `offline_access` buys a fresh id token
 * without sending Dom back to Microsoft.
 */

/** Renew this long before the id token expires, so a request in flight never carries a token about to lapse. */
export const REFRESH_MARGIN_SECONDS = 120;

export interface EntraTokenSet {
  idToken: string;
  /** Entra rotates refresh tokens; null when the response carried none, in which case the previous one still works. */
  refreshToken: string | null;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface RefreshInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scope: string;
}

/** The `exp` claim of a JWT, or null when the token cannot be read. Nothing is verified here; the api does that. */
export function jwtExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== 'object' || claims === null) return null;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** True when the token has lapsed or will within the margin. An unknown expiry counts as lapsed. */
export function needsRefresh(expiresAt: number | null | undefined, nowMs: number): boolean {
  if (expiresAt === null || expiresAt === undefined) return true;
  return expiresAt * 1000 - nowMs <= REFRESH_MARGIN_SECONDS * 1000;
}

export function entraTokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

interface TokenResponse {
  id_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * One refresh-token grant against the tenant's token endpoint. Throws with
 * Entra's own error code when the grant is refused (a revoked session, a
 * changed password, a token past its own lifetime), so the caller can end
 * the session rather than keep retrying.
 */
export async function refreshEntraTokens(
  input: RefreshInput,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<EntraTokenSet> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    scope: input.scope,
  });
  const response = await fetchImpl(entraTokenEndpoint(input.tenantId), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const code = typeof json.error === 'string' ? json.error : `HTTP ${String(response.status)}`;
    const detail =
      typeof json.error_description === 'string'
        ? ` ${json.error_description.split('\n')[0] ?? ''}`
        : '';
    throw new Error(`Entra refused to renew the sign-in (${code}).${detail}`);
  }
  if (typeof json.id_token !== 'string' || json.id_token === '') {
    throw new Error(
      'Entra renewed the sign-in without an id token. Check that the openid scope is requested.',
    );
  }
  const fromClaim = jwtExpiresAt(json.id_token);
  const fromResponse =
    typeof json.expires_in === 'number' ? Math.floor(nowMs / 1000) + json.expires_in : null;
  const expiresAt = fromClaim ?? fromResponse;
  if (expiresAt === null) {
    throw new Error('Entra renewed the sign-in without saying when the id token expires.');
  }
  return {
    idToken: json.id_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt,
  };
}
