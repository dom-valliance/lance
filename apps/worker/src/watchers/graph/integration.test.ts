import type { DeltaMessagesOptions, MessageDelta } from '@lance/connectors/graph';
import { createDb, cursors, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, SystemControl } from '@lance/ledger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PauseGate } from '../../scheduler/gate.js';
import { runWatcher, type TriageJob } from '../runner.js';
import { createGraphMailWatcher } from './mail.js';

/**
 * Non-negotiable 6: re-running a watcher over the same window produces no
 * new events. This drives the real `graph-mail` watcher through the real
 * runner against Postgres, with only Graph and the labeller faked.
 */

let container: StartedPostgreSqlContainer;
let db: Db;
let control: SystemControl;
const triaged: TriageJob[] = [];

const messages = [
  {
    id: 'msg-1',
    conversationId: 'conv-1',
    subject: 'Renewal paperwork',
    from: { emailAddress: { name: 'Priya Raman', address: 'priya@northwind.example.com' } },
    toRecipients: [{ emailAddress: { name: 'Dom Selvon', address: 'dom@valliance.ai' } }],
    receivedDateTime: '2026-09-21T08:12:44Z',
    body: { contentType: 'html', content: '<p>Paperwork <b>attached</b>.</p>' },
    webLink: 'https://outlook.office365.com/owa/?ItemID=msg-1',
  },
  {
    id: 'msg-2',
    conversationId: 'conv-1',
    subject: 'Re: Renewal paperwork',
    from: { emailAddress: { name: 'Dom Selvon', address: 'dom@valliance.ai' } },
    toRecipients: [
      { emailAddress: { name: 'Priya Raman', address: 'priya@northwind.example.com' } },
    ],
    receivedDateTime: '2026-09-21T08:20:00Z',
    body: { contentType: 'text', content: 'Signing today.' },
  },
];

const reads = {
  calls: [] as DeltaMessagesOptions[],
  deltaMessages(options: DeltaMessagesOptions): Promise<MessageDelta> {
    reads.calls.push(options);
    return Promise.resolve(
      options.folderId === 'inbox'
        ? { messages, removed: [], deltaLink: 'inbox-delta-2' }
        : { messages: [], removed: [], deltaLink: 'sent-delta-2' },
    );
  },
};

function mailWatcher() {
  return createGraphMailWatcher({
    reads,
    label: () => Promise.resolve(['Deals']),
    now: () => '2026-09-21T09:00:00.000Z',
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  control = new SystemControl(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

const deps = () => ({
  db,
  gate: new PauseGate(control),
  control,
  enqueueTriage: (job: TriageJob) => {
    triaged.push(job);
    return Promise.resolve();
  },
});

describe('graph-mail through the watcher runner', () => {
  it('writes one observation per message, groups triage by conversation and stores a delta cursor per folder', async () => {
    const summary = await runWatcher(deps(), mailWatcher());
    expect(summary.status).toBe('ran');
    expect(summary.partitions.map((partition) => partition.partition)).toEqual([
      'inbox',
      'sentitems',
    ]);
    expect(summary.partitions[0]).toMatchObject({ status: 'ok', polled: 2, inserted: 2 });

    const observed = await new LedgerReader(db).query({ kind: 'observed' });
    expect(observed).toHaveLength(2);
    const payload = observed.find((event) => event.sourceRecordId === 'msg-1')?.payload as Record<
      string,
      unknown
    >;
    expect(payload['labels']).toEqual(['Deals']);
    expect(payload['watcher']).toBe('graph-mail');
    expect(payload).not.toHaveProperty('body');
    expect(payload['bodyText']).toBe('Paperwork attached.');

    expect(triaged).toHaveLength(1);
    expect(triaged[0]?.observationEventIds).toHaveLength(2);

    const saved = await db.select().from(cursors).where(eq(cursors.watcher, 'graph-mail'));
    expect(saved.map((row) => row.key).sort()).toEqual(['__started_at', 'inbox', 'sentitems']);
    expect(saved.find((row) => row.key === 'inbox')?.value).toBe('inbox-delta-2');
  });

  it('inserts nothing when the same messages come back on the next poll', async () => {
    triaged.length = 0;
    reads.calls.length = 0;
    const summary = await runWatcher(deps(), mailWatcher());
    expect(summary.partitions[0]).toMatchObject({
      status: 'ok',
      polled: 2,
      inserted: 0,
      duplicates: 2,
    });
    expect(reads.calls[0]).toEqual({ folderId: 'inbox', deltaLink: 'inbox-delta-2' });
    expect(triaged).toHaveLength(0);
    expect(await new LedgerReader(db).query({ kind: 'observed' })).toHaveLength(2);
  });
});
