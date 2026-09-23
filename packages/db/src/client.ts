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

/**
 * Which principal, and whether as an admin, a session acts for (ADR 0015).
 * The empty principal is the unscoped session: row-level security shows it
 * no principal-bearing row and refuses its inserts.
 */
export interface SessionScope {
  readonly principalId: string;
  readonly admin: boolean;
}

const UNSCOPED: SessionScope = { principalId: '', admin: false };

const SET_SCOPE =
  "SELECT set_config('app.principal', $1, false), set_config('app.role', $2, false)";

/**
 * A pool that stamps its scope on every connection it hands out, before
 * the first statement runs. Every scope over one database shares the same
 * underlying `pg.Pool`, and every checkout sets both settings, so a
 * connection never carries one scope's value into another's query.
 *
 * Drizzle treats a client whose class name contains "Pool" as a pool and
 * checks out one connection per transaction, which is where the scope is
 * applied; the name is load-bearing.
 */
export class PrincipalScopedPool {
  constructor(
    readonly base: pg.Pool,
    readonly scope: SessionScope,
  ) {}

  async connect(): Promise<pg.PoolClient> {
    const client = await this.base.connect();
    try {
      await client.query(SET_SCOPE, [this.scope.principalId, this.scope.admin ? 'admin' : '']);
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
    return client;
  }

  async query(
    config: string | pg.QueryConfig,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult> {
    const client = await this.connect();
    try {
      return await client.query(config, values as unknown[] | undefined);
    } finally {
      client.release();
    }
  }

  /** Closes the shared pool, and with it every scope over it. */
  end(): Promise<void> {
    return this.base.end();
  }
}

export type Db = NodePgDatabase<typeof schema> & { readonly $client: PrincipalScopedPool };

const drizzleOver = (pool: PrincipalScopedPool): Db =>
  // Drizzle's types name pg's own clients; the scoped pool satisfies the
  // two methods Drizzle calls on a pool, query and connect.
  drizzle(pool as unknown as pg.Pool, { schema }) as unknown as Db;

/**
 * A handle over the same connections as `db`, scoped to one principal
 * (ADR 0015). Inserts take `principal_id` from this scope; reads see only
 * this principal's rows, plus organisation rows where a table has them.
 * `admin` lets the session write organisation rows (ADR 0019).
 */
export const scopedDb = (
  db: Db,
  scope: { readonly principalId: string; readonly admin?: boolean },
): Db => {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(scope.principalId)) {
    throw new Error(
      `scopedDb needs a principal id (a ULID from principals.id); got "${scope.principalId}".`,
    );
  }
  return drizzleOver(
    new PrincipalScopedPool(db.$client.base, {
      principalId: scope.principalId,
      admin: scope.admin ?? false,
    }),
  );
};

/** Runs `fn` with a handle scoped to one principal (ADR 0015). */
export const withPrincipal = <T>(
  db: Db,
  principalId: string,
  fn: (scoped: Db) => Promise<T>,
): Promise<T> => fn(scopedDb(db, { principalId }));

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
 * Connection settings from the environment. `DATABASE_URL` wins; otherwise
 * the `PG_*` variables the Container Apps carry (ADR 0008) are assembled,
 * with TLS verification on whenever `PG_SSL` is `require`.
 */
const connectionFromEnv = (options: CreateDbOptions): pg.PoolConfig => {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (connectionString !== undefined && connectionString !== '') {
    return { connectionString };
  }
  const host = process.env.PG_HOST;
  if (host === undefined || host === '') {
    throw new Error(
      'No database connection. Set DATABASE_URL, or PG_HOST with PG_DATABASE and PG_USER, or pass connectionString to createDb.',
    );
  }
  const config: pg.PoolConfig = {
    host,
    port: Number(process.env.PG_PORT ?? '5432'),
    database: process.env.PG_DATABASE ?? 'lance',
    user: process.env.PG_USER,
  };
  if (process.env.PG_SSL === 'require') {
    config.ssl = { rejectUnauthorized: true };
  }
  return config;
};

/**
 * `PG_ROLE` makes every session act as that role from the first statement,
 * so anything a process creates at runtime (pg-boss's tables above all) is
 * owned by the shared `lance_app` role rather than by the one Container
 * App identity that happened to create it. Without this the api cannot
 * read the queue tables the worker made, and the other way round.
 */
const applyRole = (config: pg.PoolConfig): void => {
  const role = process.env.PG_ROLE;
  if (role === undefined || role === '') return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error(
      `PG_ROLE must be a plain role name (letters, digits, underscores); got "${role}".`,
    );
  }
  config.options = `-c role=${role}`;
};

/**
 * Build an unscoped Drizzle instance over a new `pg.Pool`. Unscoped, it
 * reads no principal-bearing row; pass it to `scopedDb` for one that does.
 * Close it with `db.$client.end()`.
 */
export const createDb = (options: CreateDbOptions = {}): Db => {
  const config = connectionFromEnv(options);
  applyRole(config);
  if (options.max !== undefined) {
    config.max = options.max;
  }
  // A handshake that waits on a token fetch is what the server times out on;
  // 30 seconds is generous for a cold managed identity sidecar.
  config.connectionTimeoutMillis = 30_000;
  const password = resolvePassword(options, config.connectionString ?? '');
  if (password !== undefined) {
    config.password = password;
    if (typeof password === 'function') {
      // Fetch the first token now, outside any handshake, so the server is not
      // kept waiting while the managed identity sidecar warms up. Failures
      // surface on the first real connection, where the caller handles them.
      void password().catch(() => undefined);
    }
  }

  const pool = new pg.Pool(config);
  pool.on('error', (error: Error) => {
    console.error(`Postgres pool error: ${error.message}`);
  });
  return drizzleOver(new PrincipalScopedPool(pool, UNSCOPED));
};
