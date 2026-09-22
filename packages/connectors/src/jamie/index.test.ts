import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as packageBarrel from '../index.js';
import { FakeClock } from '../core/testing.js';
import { createJamieConnector } from './client.js';
import { checkAccess, createJamieReads } from './reads.js';
import * as jamieBarrel from './index.js';

/** Every Jamie source file, tests and fixtures apart. */
const sourceFiles = readdirSync(new URL('.', import.meta.url))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({
    name,
    text: readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'),
  }));

const writesEntryPoint = readFileSync(new URL('../writes/index.ts', import.meta.url), 'utf8');

/** A name that would belong to a write, a delete or an update. */
const WRITE_NAME = /(write|delete|remove|update|upsert|patch|archive|send[A-Z])/i;

/** A quoted HTTP method that is not a GET. */
const NON_GET_METHOD = /(['"`])(POST|PUT|PATCH|DELETE)\1/;

describe('the Jamie connector exposes no write', () => {
  it('exports no name that reads as a write from its own barrel', () => {
    const offenders = Object.keys(jamieBarrel).filter((name) => WRITE_NAME.test(name));
    expect(offenders).toEqual([]);
    expect(jamieBarrel).not.toHaveProperty('jamieWrites');
  });

  it('exports its reads from the package root and no Jamie write beside them', () => {
    expect(typeof packageBarrel.createJamieReads).toBe('function');
    expect(typeof packageBarrel.createJamieConnector).toBe('function');
    const offenders = Object.keys(packageBarrel).filter(
      (name) => /jamie/i.test(name) && WRITE_NAME.test(name),
    );
    expect(offenders).toEqual([]);
  });

  it('is absent from the writes entry point the executor imports', () => {
    expect(writesEntryPoint).not.toMatch(/jamie/i);
  });

  it('sends no POST, PUT, PATCH or DELETE from any of its source files', () => {
    const offenders = sourceFiles
      .filter((file) => NON_GET_METHOD.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it('wraps neither meetings.delete nor tasks.update', () => {
    const wrapped = sourceFiles.filter((file) =>
      /jamieProcedurePath\('(meetings\.delete|tasks\.update)'\)/.test(file.text),
    );
    expect(wrapped).toEqual([]);
  });

  it('issues a GET for every read and for the access check', async () => {
    const methods: (string | undefined)[] = [];
    const fetchImpl = ((requested: string, init?: RequestInit) => {
      methods.push(init?.method);
      const body = requested.includes('/health')
        ? { status: 'ok' }
        : { result: { data: { json: replyFor(requested) } } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    const jamie = createJamieConnector({
      apiKey: 'jk_test_only',
      clock: new FakeClock(),
      fetchImpl,
    });
    const reads = createJamieReads(jamie);
    await reads.listMeetings();
    await reads.getMeeting('mtg_0000000000000001');
    await reads.searchMeetings({ query: 'timeline' });
    await reads.listTasks();
    await reads.listTags();
    await checkAccess(jamie);
    expect(methods).toEqual(Array.from({ length: 7 }, () => 'GET'));
  });
});

/** The narrowest reply each procedure's schema accepts. */
function replyFor(requested: string): Record<string, unknown> {
  if (requested.includes('meetings.list')) return { meetings: [], nextCursor: null };
  if (requested.includes('meetings.search')) return { results: [] };
  if (requested.includes('tasks.list')) return { tasks: [], nextCursor: null };
  if (requested.includes('tags.list')) return { tags: [] };
  return {
    id: 'mtg_0000000000000001',
    title: 'Weekly delivery review',
    startTime: '2026-09-21T09:00:00.000Z',
    endTime: '2026-09-21T09:30:00.000Z',
  };
}
