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
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await db.$client.end();
  }
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runMigrations();
  console.info('Migrations applied.');
}
