import { LEGACY_GRAPH_PLACEHOLDER, principalSecretName } from '@lance/shared';
import type { SecretStore, SecretWriter } from '../secrets/index.js';

/**
 * Where a principal's delegated Graph refresh token lives. Spec 4.1:
 * "Tokens live in Key Vault, never in Postgres." Spec 4.2: the token is
 * rotated on every use. ADR 0022: one secret per principal,
 * `graph-refresh-token--<principalId>`, in the principal vault; the api
 * writes it at consent and the worker reads and rotates it.
 *
 * Nothing in this file logs, returns in an error, or otherwise reveals a
 * token value.
 */

/**
 * The one secret the whole environment used before ADR 0022, in the
 * static vault. The worker copies it once into Dom's per-principal secret
 * and never writes it.
 */
export const LEGACY_GRAPH_REFRESH_TOKEN_SECRET_NAME = 'graph-refresh-token';

/**
 * Placeholder the Phase 0 runbook wrote before the first consent. It is
 * not a token and reads as "not connected yet".
 */
export const PENDING_FIRST_CONSENT = LEGACY_GRAPH_PLACEHOLDER;

export interface GraphTokenStore {
  /** The stored refresh token, or null when the principal has never connected. */
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
}

/** What the api holds: it stores the first token at consent and can read nothing back. */
export interface GraphTokenWriter {
  setRefreshToken(token: string): Promise<void>;
}

/** The name of `principalId`'s refresh token secret in the principal vault. */
export const graphRefreshTokenSecretName = (principalId: string): string =>
  principalSecretName('graph-refresh-token', principalId);

/** The production store: one principal's secret in the principal vault. */
export class PrincipalTokenStore implements GraphTokenStore {
  readonly secretName: string;

  constructor(
    private readonly secrets: SecretStore,
    principalId: string,
  ) {
    this.secretName = graphRefreshTokenSecretName(principalId);
  }

  getRefreshToken(): Promise<string | null> {
    return this.secrets.get(this.secretName);
  }

  async setRefreshToken(token: string): Promise<void> {
    await this.secrets.set(this.secretName, token);
  }
}

/** The api's half: writes `principalId`'s secret and nothing else. */
export function principalTokenWriter(secrets: SecretWriter, principalId: string): GraphTokenWriter {
  const name = graphRefreshTokenSecretName(principalId);
  return {
    setRefreshToken: (token) => secrets.set(name, token),
  };
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
