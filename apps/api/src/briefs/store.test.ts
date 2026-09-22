import { briefs, createDb, runMigrations, seed, type Db, type NewBrief } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBriefStore, type BriefStoreLike } from './store.js';

/** The Today page's brief reads, over a real database. */

let container: StartedPostgreSqlContainer;
let db: Db;
let store: BriefStoreLike;

/** The local day of 22 September 2026 in Europe/London. */
const DAY_START = new Date('2026-09-21T23:00:00.000Z');
const DAY_END = new Date('2026-09-22T23:00:00.000Z');

const insert = async (overrides: Partial<NewBrief> = {}): Promise<string> => {
  const id = overrides.id ?? newUlid();
  await db.insert(briefs).values({
    correlationId: newUlid(),
    kind: 'morning_brief',
    content: { headline: 'Nothing in the diary.' },
    markdown: '# Morning brief',
    generatedAt: new Date('2026-09-22T05:30:00.000Z'),
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
    expect(await store.latest({ kind: 'weekly_review', from: DAY_START, to: DAY_END })).toBeNull();
  });

  it('returns the newest brief of the kind it was asked for', async () => {
    await insert({ generatedAt: new Date('2026-09-22T04:00:00.000Z') });
    const newest = await insert({
      generatedAt: new Date('2026-09-22T05:30:00.000Z'),
      content: { headline: 'Three meetings.' },
    });
    await insert({ kind: 'afternoon_board', generatedAt: new Date('2026-09-22T15:00:00.000Z') });

    const brief = await store.latest({ kind: 'morning_brief', from: DAY_START, to: DAY_END });

    expect(brief?.id).toBe(newest);
    expect(brief?.kind).toBe('morning_brief');
    expect(brief?.content).toEqual({ headline: 'Three meetings.' });
    expect(brief?.generatedAt).toBe('2026-09-22T05:30:00.000Z');
  });

  it('ignores a brief generated outside the local day it was asked for', async () => {
    await insert({ generatedAt: new Date('2026-09-20T05:30:00.000Z') });

    const brief = await store.latest({
      kind: 'morning_brief',
      from: new Date('2026-09-18T23:00:00.000Z'),
      to: new Date('2026-09-19T23:00:00.000Z'),
    });

    expect(brief).toBeNull();
  });

  it('breaks a tie on generated_at with the id, so latest is one row', async () => {
    const at = new Date('2026-09-22T06:00:00.000Z');
    const lower = newUlid();
    const higher = newUlid();
    const [first, second] = lower < higher ? [lower, higher] : [higher, lower];
    await insert({ id: first, generatedAt: at });
    await insert({ id: second, generatedAt: at });

    expect((await store.latest({ kind: 'morning_brief', from: DAY_START, to: DAY_END }))?.id).toBe(
      second,
    );
  });

  it('lists briefs newest first and pages from a cursor', async () => {
    const first = await store.list({ limit: 2 });
    expect(first).toHaveLength(2);
    expect(first[0]!.id > first[1]!.id).toBe(true);

    const next = await store.list({ limit: 2, cursor: first[1]!.id });

    expect(next.every((row) => row.id < first[1]!.id)).toBe(true);
  });

  it('lists only the kind it was asked for', async () => {
    const rows = await store.list({ kind: 'afternoon_board', limit: 10 });

    expect(rows.map((row) => row.kind)).toEqual(['afternoon_board']);
  });

  it('reads one brief by id and nothing for an id it does not hold', async () => {
    const id = await insert({ markdown: '# Just this one' });

    expect((await store.get(id))?.markdown).toBe('# Just this one');
    expect(await store.get(newUlid())).toBeNull();
  });
});
