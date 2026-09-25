import type { Session } from 'next-auth';
import { PRINCIPAL_STATUSES, type PrincipalStatus } from './principal';
import { lanceRolesFrom } from './roles';

/** Where auth.ts keeps the Entra id token in the JWT. */
export const ID_TOKEN_CLAIM = 'idToken';

/** What auth.ts writes to the JWT when a renewal fails. */
export const REFRESH_ERROR = 'RefreshTokenError';

function claimStatus(token: Record<string, unknown>): PrincipalStatus | null {
  const value = token['principalStatus'];
  return typeof value === 'string' && (PRINCIPAL_STATUSES as readonly string[]).includes(value)
    ? (value as PrincipalStatus)
    : null;
}

/**
 * The session Auth.js builds from the JWT. `/api/auth/session` serves it
 * to browser JavaScript, so it carries what a page may show (the roles,
 * the Entra object id, the principal's status) and never a credential:
 * the Entra id token stays in the encrypted JWT, where server-side code
 * reads it through `serverIdToken` (auth/id-token.ts).
 */
export function sessionFromToken<S extends Pick<Session, 'expires'>>(
  session: S,
  token: Record<string, unknown>,
): S & Pick<Session, 'error' | 'roles' | 'oid' | 'principalStatus'> {
  if (token['error'] === REFRESH_ERROR) {
    return { ...session, error: REFRESH_ERROR };
  }
  const oid = token['oid'];
  return {
    ...session,
    roles: lanceRolesFrom(token['roles']),
    ...(typeof oid === 'string' && oid !== '' ? { oid } : {}),
    principalStatus: claimStatus(token),
  };
}
