import type { SecretReader, SecretStore } from '@lance/connectors';
import type { Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { isUnsetSecretValue, newUlid, nowIso } from '@lance/shared';

/**
 * The one-time move of Dom's credentials into the principal vault
 * (ADR 0022). Before per-principal secrets there was one Graph refresh
 * token (`graph-refresh-token` in the static vault) and one Jamie key
 * (`JAMIE_API_KEY`, bound from `jamie-api-key`). On first use for the
 * principal whose UPN is `config.dom.email`, the worker copies each into
 * that principal's own secret when the per-principal secret is absent,
 * records the copy in the ledger, and never touches the old secret, so a
 * failed copy leaves everything as it was.
 *
 * The fallback stays until dev and prod have each recorded both copies
 * (`credential_migrated` events for graph and jamie); a follow-up then
 * deletes this module, the worker's KEY_VAULT_URL and its jamie-api-key
 * binding, and Dom deletes the two old secrets by hand.
 */

export interface LegacyCopy {
  /** The connector the credential belongs to, for the ledger. */
  connector: 'graph' | 'jamie';
  /** Where the old value lives, for the ledger: a secret or variable name, never a value. */
  from: string;
  /** Reads the old value; null when it is absent or a placeholder. */
  read: () => Promise<string | null>;
}

export interface CopyDeps {
  /** The principal vault. */
  vault: SecretStore;
  /** The principal's scoped handle, for the ledger event. */
  db: Db;
  actor: string;
}

/**
 * The principal's secret `name`, copied from `legacy` first when it is
 * absent. Returns null when neither holds a value. The caller serialises
 * this with the rotation lock when the credential rotates, so a copy
 * never lands over a token another replica has just rotated.
 */
export async function readOrCopy(
  deps: CopyDeps,
  name: string,
  legacy: LegacyCopy | null,
): Promise<string | null> {
  const current = await deps.vault.get(name);
  if (current !== null || legacy === null) return current;
  const old = await legacy.read();
  if (old === null) return null;
  await deps.vault.set(name, old);
  await new LedgerWriter(deps.db).append({
    ts: nowIso(),
    actor: deps.actor,
    kind: 'state_changed',
    sourceSystem: 'lance',
    correlationId: newUlid(),
    payload: {
      change: 'credential_migrated',
      connector: legacy.connector,
      from: legacy.from,
      to: name,
    },
  });
  return old;
}

/** The static vault's `graph-refresh-token`, Dom's token before ADR 0022. */
export function legacyGraphToken(staticVault: SecretReader | null): LegacyCopy | null {
  if (staticVault === null) return null;
  return {
    connector: 'graph',
    from: 'graph-refresh-token',
    read: () => staticVault.get('graph-refresh-token'),
  };
}

/** `JAMIE_API_KEY`, Dom's Jamie key before ADR 0022, bound from the static `jamie-api-key`. */
export function legacyJamieKey(env: NodeJS.ProcessEnv): LegacyCopy | null {
  const value = env['JAMIE_API_KEY'];
  if (isUnsetSecretValue(value)) return null;
  return {
    connector: 'jamie',
    from: 'JAMIE_API_KEY',
    read: () => Promise.resolve(value ?? null),
  };
}
