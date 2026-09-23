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

/**
 * A migrated test database's handle, seeded and scoped to the seed
 * principal (ADR 0015), which is how the apps see the database. The
 * container's superuser still bypasses row-level security; the isolation
 * suites in this package connect as a lance_app member instead.
 */
export async function openSeededTestDb(connectionString: string): Promise<Db> {
  const root = createDb({ connectionString, password: 'postgres' });
  await seed(root);
  return scopedDb(root, { principalId: SEED_PRINCIPAL_ID });
}
