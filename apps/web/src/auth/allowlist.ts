/**
 * Lance has exactly one allowed user in v1: Dom. This decision is
 * deliberately a pure function so the sign-in callback in ../auth.ts stays
 * a thin wrapper and the comparison rule itself is unit tested in isolation.
 */
export function isAllowedUpn(candidate: string | null | undefined, allowed: string): boolean {
  if (!candidate) {
    return false;
  }
  return candidate.trim().toLowerCase() === allowed.trim().toLowerCase();
}
