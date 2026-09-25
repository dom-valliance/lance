import { z } from 'zod';

/**
 * The Entra app roles that grant access to Lance (ADR 0020). Tokens carry
 * the value in their `roles` claim; Graph names an assignment by the id.
 * The ids were generated once and are the same ones
 * `scripts/entra/setup-app-roles.sh` writes into the app registration.
 */
export const LANCE_ROLES = ['Lance.User', 'Lance.Admin'] as const;
export const LanceRoleSchema = z.enum(LANCE_ROLES);
export type LanceRole = z.infer<typeof LanceRoleSchema>;

export const LANCE_ROLE_IDS: Readonly<Record<LanceRole, string>> = {
  'Lance.User': 'b98fd184-521c-4ebe-9889-bb9d03c8322c',
  'Lance.Admin': '3f59d957-584d-4fc7-9233-45d4979d06f8',
};

/** The Lance roles among a token's `roles` claim, ignoring anything else it carries. */
export const lanceRolesFrom = (claim: unknown): LanceRole[] => {
  if (!Array.isArray(claim)) return [];
  const roles = claim.filter(
    (value): value is LanceRole => LanceRoleSchema.safeParse(value).success,
  );
  return [...new Set(roles)];
};

/** Either role admits a person to Lance; `Lance.Admin` alone opens the admin procedures. */
export const hasLanceAccess = (roles: readonly LanceRole[]): boolean => roles.length > 0;

export const isLanceAdmin = (roles: readonly LanceRole[]): boolean => roles.includes('Lance.Admin');
