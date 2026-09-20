import { DefaultAzureCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

/**
 * The connection pool for every relational table (ADR 0010) and the Entra
 * token callback from ADR 0008.
 */

/** Scope Azure Database for PostgreSQL Flexible Server accepts as a password. */
export const AZURE_POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/** Refresh the token this far ahead of expiry, per ADR 0008. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface CreateDbOptions {
  /** Defaults to `DATABASE_URL`. */
  readonly connectionString?: string;
  /** Defaults to `PG_PASSWORD`. Set means no Entra token is requested. */
  readonly password?: string;
  /** Injected in tests. Defaults to `DefaultAzureCredential`. */
  readonly credential?: TokenCredential;
  /** Maximum pooled connections. `pg` defaults to 10. */
  readonly max?: number;
}

export type Db = NodePgDatabase<typeof schema> & { readonly $client: pg.Pool };

const hasPasswordInUrl = (connectionString: string): boolean => {
  try {
    return new URL(connectionString).password !== '';
  } catch {
    // Not a URL-shaped connection string, so it carries no userinfo password.
    return false;
  }
};

/**
 * A `pg` password callback that returns an Entra access token, cached until
 * five minutes before it expires. Tokens are never logged.
 */
export const createEntraPasswordProvider = (
  credential: TokenCredential,
): (() => Promise<string>) => {
  let cached: AccessToken | undefined;

  return async (): Promise<string> => {
    if (cached !== undefined && cached.expiresOnTimestamp - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return cached.token;
    }

    const token = await credential.getToken(AZURE_POSTGRES_SCOPE);
    if (token === null) {
      throw new Error(
        `No Entra token for ${AZURE_POSTGRES_SCOPE}. Assign a managed identity to this ` +
          'Container App and grant it the lance_app role, or set PG_PASSWORD for local use.',
      );
    }

    cached = token;
    return token.token;
  };
};

const resolvePassword = (
  options: CreateDbOptions,
  connectionString: string,
): string | (() => Promise<string>) | undefined => {
  const password = options.password ?? process.env.PG_PASSWORD;
  if (password !== undefined && password !== '') {
    return password;
  }
  if (hasPasswordInUrl(connectionString)) {
    return undefined;
  }
  return createEntraPasswordProvider(options.credential ?? new DefaultAzureCredential());
};

/**
 * Build a Drizzle instance over a `pg.Pool`. Close it with `db.$client.end()`.
 */
export const createDb = (options: CreateDbOptions = {}): Db => {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'No database connection string. Set DATABASE_URL, or pass connectionString to createDb.',
    );
  }

  const config: pg.PoolConfig = { connectionString };
  if (options.max !== undefined) {
    config.max = options.max;
  }
  const password = resolvePassword(options, connectionString);
  if (password !== undefined) {
    config.password = password;
  }

  return drizzle(new pg.Pool(config), { schema });
};
