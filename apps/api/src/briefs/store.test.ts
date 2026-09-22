import { briefs, createDb, runMigrations, seed, type Db, type NewBrief } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBriefStore, type BriefStoreLike } from './store.js';

/** The Today page's brief read, over a real database. */

let container: StartedPostgreSqlContainer;
let db: Db;
let store: BriefStoreLike;

const insert = async (overrides: Partial<NewBrief> = {}): Promise<string> => {
  const id = overrides.id ?? newUlid();
  await db.insert(briefs).values({
    correlationId: newUlid(),
    kind: 'morning_brief',
    content: { headline: 'Nothing in the diary.' },
    markdown: '# Morning brief',
    generatedAt: new Date('2026-09-21T05:30:00.000Z'),
    ...overrides,
    id,
  });
  return id;
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  store = createBriefStore(db);
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('createBriefStore', () => {
  it('returns nothing for a kind that has never been generated', async () => {
    expect(await store.latest('weekly_review')).toBeNull();
  });

  it('returns the newest brief of the kind it was asked for', async () => {
    await insert({ generatedAt: new Date('2026-09-20T05:30:00.000Z') });
    const newest = await insert({
      generatedAt: new Date('2026-09-22T05:30:00.000Z'),
      content: { headline: 'Three meetings.' },
    });
    await insert({ kind: 'afternoon_board', generatedAt: new Date('2026-09-22T15:00:00.000Z') });

    const brief = await store.latest('morning_brief');

    expect(brief?.id).toBe(newest);
    expect(brief?.kind).toBe('morning_brief');
    expect(brief?.content).toEqual({ headline: 'Three meetings.' });
    expect(brief?.generatedAt).toBe('2026-09-22T05:30:00.000Z');
  });

  it('breaks a tie on generated_at with the id, so latest is one row', async () => {
    const at = new Date('2026-09-23T05:30:00.000Z');
    const lower = newUlid();
    const higher = newUlid();
    const [first, second] = lower < higher ? [lower, higher] : [higher, lower];
    await insert({ id: first, generatedAt: at });
    await insert({ id: second, generatedAt: at });

    expect((await store.latest('morning_brief'))?.id).toBe(second);
  });
});
