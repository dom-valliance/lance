import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, scopedDb, type Db } from './client.js';
import { SEED_PRINCIPAL_ID, seed } from './seed.js';

/** The local image built by `docker compose build`, PostgreSQL 16 with AGE and pgvector (ADR 0004). */
export const POSTGRES_TEST_IMAGE = 'lance-postgres:16';

function isTransientDockerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /pull access denied|404|EOF|socket hang up|ECONNRESET/i.test(message);
}

/**
 * Starts a throwaway Postgres for integration tests. Docker occasionally
 * fails the local image lookup while another container operation is in
 * flight and then tries to pull `lance-postgres`, which does not exist in
 * any registry. That is transient, so one retry after a short pause covers it.
 */
export async function startPostgresContainer(attempts = 3): Promise<StartedPostgreSqlContainer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await new PostgreSqlContainer(POSTGRES_TEST_IMAGE)
        .withDatabase('lance')
        .withUsername('postgres')
        .withPassword('postgres')
        .start();
    } catch (error) {
      lastError = error;
      if (!isTransientDockerError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The login role app suites connect as: a lance_app member, as the apps are. */
const TEST_APP_ROLE = 'lance_test_app';
const TEST_APP_PASSWORD = 'lance_test_app';

/**
 * A migrated test database's unscoped handle, seeded, logged in as a member
 * of lance_app rather than as the container's superuser, who would bypass
 * row-level security. For code under test that scopes handles itself, as
 * the api's per-principal dependency cache does; everything else takes
 * `openSeededTestDb`.
 */
export async function openAppTestDb(connectionString: string): Promise<Db> {
  const root = createDb({ connectionString, password: 'postgres' });
  try {
    await seed(root);
    await root.$client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_APP_ROLE}') THEN
           CREATE ROLE ${TEST_APP_ROLE} LOGIN PASSWORD '${TEST_APP_PASSWORD}';
         END IF;
       END $$`,
    );
    await root.$client.query(`GRANT lance_app TO ${TEST_APP_ROLE}`);
  } finally {
    await root.$client.end();
  }
  const url = new URL(connectionString);
  url.username = TEST_APP_ROLE;
  url.password = TEST_APP_PASSWORD;
  return createDb({ connectionString: url.toString(), password: TEST_APP_PASSWORD });
}

/**
 * A migrated test database's handle, seeded and scoped to the seed
 * principal (ADR 0015), which is how the apps see the database. It logs in
 * as a member of lance_app, so a suite that passes has passed under the
 * same policies the apps run under.
 */
export async function openSeededTestDb(connectionString: string): Promise<Db> {
  return scopedDb(await openAppTestDb(connectionString), { principalId: SEED_PRINCIPAL_ID });
}

/**
 * A superuser handle scoped to the seed principal, for fixture work the
 * application role is rightly refused: clearing a table between cases,
 * creating a second principal. Code under test takes `openSeededTestDb`.
 */
export function openFixtureDb(connectionString: string): Db {
  return scopedDb(createDb({ connectionString, password: 'postgres' }), {
    principalId: SEED_PRINCIPAL_ID,
  });
}
