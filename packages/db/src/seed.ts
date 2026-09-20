import { pathToFileURL } from 'node:url';
import { createDb, type CreateDbOptions, type Db } from './client.js';
import { systemState, SYSTEM_STATE_ID } from './schema/system-state.js';
import { users } from './schema/users.js';

/**
 * Rows the application cannot start without. Policy rules are not seeded
 * here; `packages/policy` owns those (spec section 6.2).
 *
 * Every insert is `ON CONFLICT DO NOTHING`, so seeding an existing database
 * changes nothing and never overwrites a value Dom has edited.
 */

const DOM_USER_ID = '01K5S9V6QW3SWCCPVB0N0E300H';
const DOM_UPN = 'dom@valliance.ai';
const DOM_NOTION_USER_ID = '1fdd872b-594c-8146-b22f-00028f1f5a41';

export const seed = async (db: Db): Promise<void> => {
  await db.insert(systemState).values({ id: SYSTEM_STATE_ID }).onConflictDoNothing();
  await db
    .insert(users)
    .values({ id: DOM_USER_ID, upn: DOM_UPN, notionUserId: DOM_NOTION_USER_ID })
    .onConflictDoNothing();
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
