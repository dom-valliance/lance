import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

/**
 * Where the delegated Graph refresh token lives. Spec 4.1: "Tokens live in
 * Key Vault, never in Postgres." Spec 4.2: the token is rotated on every
 * use, so the store is written far more often than it is read.
 *
 * Nothing in this file logs, returns in an error, or otherwise reveals a
 * token value.
 */

/** The Key Vault secret name the Entra runbook provisions. */
export const GRAPH_REFRESH_TOKEN_SECRET_NAME = 'graph-refresh-token';

/**
 * Placeholder the infrastructure writes so the Key Vault reference on the
 * Container App resolves before Dom has consented. It is not a token and
 * reads as "not connected yet".
 */
export const PENDING_FIRST_CONSENT = 'pending-first-consent';

export interface GraphTokenStore {
  /** The stored refresh token, or null when Lance has never been connected. */
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
}

/** The part of `SecretClient` this store uses, so a test can supply a double. */
export interface SecretClientLike {
  getSecret(name: string): Promise<{ value?: string | undefined }>;
  setSecret(name: string, value: string): Promise<unknown>;
}

function isSecretNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  const code = 'code' in error ? error.code : undefined;
  return statusCode === 404 || code === 'SecretNotFound';
}

/** The production store: one secret in the environment's Key Vault. */
export class KeyVaultTokenStore implements GraphTokenStore {
  constructor(
    private readonly client: SecretClientLike,
    private readonly secretName: string = GRAPH_REFRESH_TOKEN_SECRET_NAME,
  ) {}

  /**
   * Builds the store over `KEY_VAULT_URL` and the Container App's managed
   * identity. `DefaultAzureCredential` also picks up the Azure CLI login
   * on a developer machine, so the same code path works locally.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): KeyVaultTokenStore {
    const vaultUrl = env['KEY_VAULT_URL'];
    if (vaultUrl === undefined || vaultUrl === '') {
      throw new Error(
        'Missing required environment variable "KEY_VAULT_URL". It is the vault URI printed by docs/runbooks/deploy.md step 3, for example https://kv-lance-dev-abcd.vault.azure.net.',
      );
    }
    return new KeyVaultTokenStore(new SecretClient(vaultUrl, new DefaultAzureCredential()));
  }

  async getRefreshToken(): Promise<string | null> {
    let value: string | undefined;
    try {
      value = (await this.client.getSecret(this.secretName)).value;
    } catch (error) {
      if (isSecretNotFound(error)) return null;
      throw error;
    }
    if (value === undefined || value === '' || value === PENDING_FIRST_CONSENT) return null;
    return value;
  }

  async setRefreshToken(token: string): Promise<void> {
    await this.client.setSecret(this.secretName, token);
  }
}

/**
 * For tests and local development. `fromEnv` reads `GRAPH_REFRESH_TOKEN`
 * so a developer can run a watcher against their own mailbox without a
 * vault; it is a development convenience only, and no deployed
 * environment sets that variable (secrets reach the containers as Key
 * Vault references, CLAUDE.md conventions).
 */
export class InMemoryTokenStore implements GraphTokenStore {
  private token: string | null;

  constructor(initial: string | null = null) {
    this.token = initial === PENDING_FIRST_CONSENT ? null : initial;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): InMemoryTokenStore {
    const value = env['GRAPH_REFRESH_TOKEN'];
    return new InMemoryTokenStore(value === undefined || value === '' ? null : value);
  }

  getRefreshToken(): Promise<string | null> {
    return Promise.resolve(this.token);
  }

  setRefreshToken(token: string): Promise<void> {
    this.token = token;
    return Promise.resolve();
  }
}
