import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, scopedDb, type CreateDbOptions, type Db } from './client.js';
import { principalState } from './schema/principal-state.js';
import { principals } from './schema/principals.js';
import { systemState, SYSTEM_STATE_ID } from './schema/system-state.js';

/**
 * Rows the application cannot start without. Policy rules are not seeded
 * here; `packages/policy` owns those (spec section 6.2).
 *
 * Every insert is `ON CONFLICT DO NOTHING`, so seeding an existing database
 * changes nothing and never overwrites a value Dom has edited.
 */

/** The v1 principal. Migration 0009 made his `users` row this principal. */
export const SEED_PRINCIPAL_ID = '01K5S9V6QW3SWCCPVB0N0E300H';
const SEED_PRINCIPAL_UPN = 'dom@valliance.ai';
const SEED_PRINCIPAL_NOTION_USER_ID = '1fdd872b-594c-8146-b22f-00028f1f5a41';

export const seed = async (db: Db): Promise<void> => {
  // The global mode is a ceiling over every principal's own mode (ADR 0015).
  // It starts open; each principal's own mode starts in dry run.
  await db.insert(systemState).values({ id: SYSTEM_STATE_ID, mode: 'live' }).onConflictDoNothing();
  // Migration 0009 may already have made the principal from a users row
  // under a different id; the seed then adds nothing and uses that row.
  const existing = await db
    .select({ id: principals.id })
    .from(principals)
    .where(eq(principals.upn, SEED_PRINCIPAL_UPN))
    .limit(1);
  const principalId = existing[0]?.id ?? SEED_PRINCIPAL_ID;
  if (existing[0] === undefined) {
    await db.insert(principals).values({
      id: SEED_PRINCIPAL_ID,
      upn: SEED_PRINCIPAL_UPN,
      notionUserId: SEED_PRINCIPAL_NOTION_USER_ID,
    });
  }
  // principal_state is under row-level security, so the row is written in
  // the principal's own scope and takes its principal_id from it.
  await scopedDb(db, { principalId })
    .insert(principalState)
    .values({})
    .onConflictDoNothing({ target: principalState.principalId });
};

export const runSeed = async (options: CreateDbOptions = {}): Promise<void> => {
  const db = createDb(options);
  try {
    await seed(db);
  } finally {
    await db.$client.end();
  }
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runSeed();
  console.info('Seed applied.');
}
