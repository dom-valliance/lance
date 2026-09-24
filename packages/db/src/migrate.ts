import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type CreateDbOptions } from './client.js';

/** The forward-only migration history for the whole database (ADR 0010). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Apply every migration that has not run yet. Drizzle records applied
 * migrations in `drizzle.__drizzle_migrations`, so a second run is a no-op.
 */
export const runMigrations = async (options: CreateDbOptions = {}): Promise<void> => {
  const db = createDb(options);
  // A query error inside the migration transaction can otherwise surface only
  // as a bare "Connection terminated unexpectedly" from the checked-out client.
  // Print the first real message so the job log names the failing statement.
  db.$client.base.on('connect', (client) => {
    client.on('error', (error: Error) => {
      console.error(`Postgres client error during migration: ${error.message}`);
    });
  });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
    console.error(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}${cause ? ` (cause: ${cause})` : ''}`,
    );
    throw error;
  } finally {
    await db.$client.end();
  }
};

const CONNECTION_ERROR =
  /terminated unexpectedly|ECONNRESET|ETIMEDOUT|timeout expired|Connection terminated/i;

/**
 * Migrations are transactional, so a run cut off by a dropped connection can
 * be repeated safely. A fresh Container Apps job replica sometimes loses its
 * first connection while the managed identity sidecar is still warming up.
 */
export const runMigrationsWithRetry = async (
  options: CreateDbOptions = {},
  attempts = 5,
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runMigrations(options);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !CONNECTION_ERROR.test(message)) throw error;
      console.warn(
        `Migration attempt ${attempt} lost its connection (${message}); retrying in ${attempt * 5} s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runMigrationsWithRetry();
  console.info('Migrations applied.');
}
