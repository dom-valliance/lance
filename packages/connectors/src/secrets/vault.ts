import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { isUnsetSecretValue } from '@lance/shared';

/**
 * Key Vault as the apps use it (ADR 0022): the static vault, which only the
 * worker reads through the SDK, and the principal vault, which the worker
 * reads and writes and the api may only write. The two halves are separate
 * interfaces so the api's handle cannot even name a read.
 *
 * Nothing here logs, returns in an error, or otherwise reveals a secret
 * value. An error carries the secret's name, which is not a secret.
 */

/** The part of `SecretClient` these stores use, so a test can supply a double. */
export interface SecretClientLike {
  getSecret(name: string): Promise<{ value?: string | undefined }>;
  setSecret(name: string, value: string): Promise<unknown>;
  /**
   * Starts a soft delete and resolves with a poller. Optional because only
   * the worker's principal vault deletes (offboarding); a double that never
   * deletes can leave it out.
   */
  beginDeleteSecret?(name: string): Promise<{ pollUntilDone(): Promise<unknown> }>;
}

export interface SecretReader {
  /** The current value, or null when the secret is absent or still a placeholder. */
  get(name: string): Promise<string | null>;
}

export interface SecretWriter {
  /** Writes a new current version, creating the secret when it does not exist. */
  set(name: string, value: string): Promise<void>;
}

export type SecretStore = SecretReader & SecretWriter;

/** What a delete found: the secret was there and is now deleted, or it was already gone. */
export type SecretDeleteOutcome = 'deleted' | 'absent';

export interface SecretDeleter {
  /**
   * Deletes the secret. In a vault with purge protection (both of Lance's)
   * this is a soft delete: the value stays recoverable by a Secrets Officer
   * until the retention period ends, and nobody can purge it early.
   */
  delete(name: string): Promise<SecretDeleteOutcome>;
}

function isSecretNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  const code = 'code' in error ? error.code : undefined;
  return statusCode === 404 || code === 'SecretNotFound';
}

/** One vault over a `SecretClient`. */
export class KeyVaultSecrets implements SecretStore, SecretDeleter {
  constructor(private readonly client: SecretClientLike) {}

  /**
   * A vault reached with the Container App's managed identity.
   * `DefaultAzureCredential` also picks up the Azure CLI login on a
   * developer machine, so the same code path works locally.
   */
  static at(vaultUrl: string): KeyVaultSecrets {
    return new KeyVaultSecrets(new SecretClient(vaultUrl, new DefaultAzureCredential()));
  }

  async get(name: string): Promise<string | null> {
    let value: string | undefined;
    try {
      value = (await this.client.getSecret(name)).value;
    } catch (error) {
      if (isSecretNotFound(error)) return null;
      throw error;
    }
    return isUnsetSecretValue(value) ? null : (value ?? null);
  }

  async set(name: string, value: string): Promise<void> {
    await this.client.setSecret(name, value);
  }

  async delete(name: string): Promise<SecretDeleteOutcome> {
    if (this.client.beginDeleteSecret === undefined) {
      throw new Error(
        `This Key Vault client cannot delete secrets, so ${name} was left in place. Build the store with KeyVaultSecrets.at.`,
      );
    }
    try {
      const poller = await this.client.beginDeleteSecret(name);
      await poller.pollUntilDone();
    } catch (error) {
      // Absent, or already soft-deleted by an earlier run: either way the
      // secret is no longer readable, which is what the caller wants.
      if (isSecretNotFound(error)) return 'absent';
      throw error;
    }
    return 'deleted';
  }
}

/** A write-only view: what the api holds on the principal vault. */
export function writeOnly(store: SecretWriter): SecretWriter {
  return { set: (name, value) => store.set(name, value) };
}

const envValue = (env: NodeJS.ProcessEnv, variable: string): string | null => {
  const value = env[variable];
  return value === undefined || value === '' ? null : value;
};

/**
 * The principal vault from `PRINCIPAL_KEY_VAULT_URL` (for example
 * https://kv-lance-p-dev-abcd.vault.azure.net), or null when the variable
 * is unset, as in a local run without Azure.
 */
export function principalVaultFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeyVaultSecrets | null {
  const url = envValue(env, 'PRINCIPAL_KEY_VAULT_URL');
  return url === null ? null : KeyVaultSecrets.at(url);
}

/** The static vault from `KEY_VAULT_URL`, or null when the variable is unset. */
export function staticVaultFromEnv(env: NodeJS.ProcessEnv = process.env): KeyVaultSecrets | null {
  const url = envValue(env, 'KEY_VAULT_URL');
  return url === null ? null : KeyVaultSecrets.at(url);
}

/**
 * For tests and local development: a vault in memory. `values` seeds it;
 * `writes` records every set in order, values included, for assertions.
 */
export class InMemorySecrets implements SecretStore, SecretDeleter {
  private readonly values = new Map<string, string>();
  readonly writes: { name: string; value: string }[] = [];
  readonly reads: string[] = [];
  readonly deletes: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.values.set(name, value);
  }

  get(name: string): Promise<string | null> {
    this.reads.push(name);
    const value = this.values.get(name);
    return Promise.resolve(isUnsetSecretValue(value) ? null : (value ?? null));
  }

  set(name: string, value: string): Promise<void> {
    this.writes.push({ name, value });
    this.values.set(name, value);
    return Promise.resolve();
  }

  delete(name: string): Promise<SecretDeleteOutcome> {
    this.deletes.push(name);
    return Promise.resolve(this.values.delete(name) ? 'deleted' : 'absent');
  }

  has(name: string): boolean {
    return this.values.has(name);
  }
}
