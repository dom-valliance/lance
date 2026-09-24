import { UlidSchema } from './schemas.js';

/**
 * Per-principal credentials in the principal vault, kv-lance-p-<env>
 * (ADR 0022, docs/plans/multi-user.md M2). One secret per principal and
 * connector, named `<connector secret>--<principalId>`: Key Vault names
 * allow letters, digits and hyphens, and a ULID is letters and digits.
 */
export const PRINCIPAL_SECRET_KINDS = [
  'graph-refresh-token',
  'jamie-api-key',
  // Reserved for Phase 7 (ADR 0016); nothing writes it yet.
  'foundry-refresh-token',
] as const;
export type PrincipalSecretKind = (typeof PRINCIPAL_SECRET_KINDS)[number];

/**
 * The value the template writes into a static secret it had to create
 * (infra/modules/keyvault.bicep). It is not a credential, and a reader
 * treats it as "not set".
 */
export const PLACEHOLDER_SECRET_VALUE = 'lance-placeholder-set-me';

/**
 * The placeholder the Phase 0 runbook set in `graph-refresh-token` before
 * the first consent. Also read as "not set".
 */
export const LEGACY_GRAPH_PLACEHOLDER = 'pending-first-consent';

/** True for a value that is absent or one of the placeholders above. */
export function isUnsetSecretValue(value: string | null | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === PLACEHOLDER_SECRET_VALUE ||
    value === LEGACY_GRAPH_PLACEHOLDER
  );
}

/**
 * The secret name for one principal's credential. Refuses anything but a
 * ULID, so a principal id can never widen into another secret's name.
 */
export function principalSecretName(kind: PrincipalSecretKind, principalId: string): string {
  const parsed = UlidSchema.safeParse(principalId);
  if (!parsed.success) {
    throw new Error(
      `A principal secret name needs a principal id that is a ULID; got ${JSON.stringify(principalId)}. ` +
        'Pass the id from the principals table.',
    );
  }
  return `${kind}--${parsed.data}`;
}
