import { jwtClaims } from './refresh';

/**
 * Who may sign in (ADR 0020): anyone whose Entra id token carries the
 * Lance.User or Lance.Admin app role. The api makes the same check on every
 * request; this one decides whether Auth.js issues a session at all, so a
 * person without a role lands on the sign-in page's refusal through
 * `error=AccessDenied`.
 */

export const LANCE_ROLES = ['Lance.User', 'Lance.Admin'] as const;
export type LanceRole = (typeof LANCE_ROLES)[number];

const isLanceRole = (value: unknown): value is LanceRole =>
  typeof value === 'string' && (LANCE_ROLES as readonly string[]).includes(value);

/** The Lance roles in a `roles` claim, ignoring anything else it carries. */
export function lanceRolesFrom(claim: unknown): LanceRole[] {
  if (!Array.isArray(claim)) return [];
  return [...new Set(claim.filter(isLanceRole))];
}

/** Either role admits a person to Lance. */
export function hasLanceAccess(roles: readonly LanceRole[]): boolean {
  return roles.length > 0;
}

export interface IdTokenIdentity {
  /** The Entra object id, the key the api binds a principal to. */
  oid: string | null;
  roles: LanceRole[];
}

/** The object id and Lance roles an id token carries. Unverified; the api verifies. */
export function identityFromIdToken(idToken: string): IdTokenIdentity {
  const claims = jwtClaims(idToken) ?? {};
  const oid = claims['oid'];
  return {
    oid: typeof oid === 'string' && oid !== '' ? oid : null,
    roles: lanceRolesFrom(claims['roles']),
  };
}

/**
 * The sign-in decision. Auth.js hands the callback the id token's claims
 * as `profile`; a profile whose `roles` holds neither Lance role is refused.
 */
export function admitsSignIn(profile: object | null | undefined): boolean {
  const roles: unknown =
    profile === null || profile === undefined ? undefined : (profile as { roles?: unknown }).roles;
  return hasLanceAccess(lanceRolesFrom(roles));
}
