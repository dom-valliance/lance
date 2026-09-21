/**
 * The ledger actor for a verified caller. `ActorSchema` in `@lance/shared`
 * allows `user:<letters>`, so the UPN's local part is lower-cased and
 * stripped of anything else: `dom@valliance.ai` becomes `user:dom`. The
 * value never comes from the request body; it comes from the token the
 * Entra verifier has already checked.
 */
export const actorFromUpn = (upn: string): string => {
  const local = upn.split('@')[0] ?? '';
  const name = local.toLowerCase().replace(/[^a-z]/g, '');
  if (name.length === 0) {
    throw new Error(
      `Cannot derive a ledger actor from the UPN "${upn}": its local part has no letters. Sign in with the allowlisted account.`,
    );
  }
  return `user:${name}`;
};
