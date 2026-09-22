import { createDb, observations, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { hashRecord, idempotencyKey, stableUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clientMailUnansweredDetector } from './clientMailUnanswered.js';
import type { DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

/** Thursday lunchtime. Monday 21 September is three working days earlier. */
const NOW = '2026-09-24T12:00:00.000Z';
const correlationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const context = (): DetectorContext => ({ db, config, ontology, now: () => NOW });

interface MailOptions {
  id: string;
  conversationId: string;
  folder: 'inbox' | 'sentitems';
  at: string;
  from: { name: string; address: string };
  subject?: string;
}

function mail(options: MailOptions): Record<string, unknown> {
  return {
    id: options.id,
    conversationId: options.conversationId,
    internetMessageId: `<${options.id}@example.test>`,
    subject: options.subject ?? 'Revised statement of work',
    from: { name: options.from.name, address: options.from.address },
    toRecipients: [{ name: 'Dom Selvon', address: 'dom@valliance.ai' }],
    ccRecipients: [],
    receivedDateTime: options.folder === 'inbox' ? options.at : null,
    sentDateTime: options.folder === 'sentitems' ? options.at : null,
    bodyPreview: 'Could you send the revised SOW',
    bodyText: 'Could you send the revised SOW when you have a moment.',
    folder: options.folder,
    removed: false,
  };
}

async function observe(options: MailOptions): Promise<string> {
  const record = mail(options);
  const hash = hashRecord(record);
  await new LedgerWriter(db).append({
    ts: options.at,
    actor: 'agent:watcher-graph-mail@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: options.id,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('graph', options.id, hash),
    correlationId: stableUlid(`graph:${options.conversationId}`),
    payload: { ...record, watcher: 'graph-mail', labels: ['Deals'] },
  });
  return hash;
}

const ann = { name: 'Ann Example', address: 'ann@client.test' };
const dom = { name: 'Dom Selvon', address: 'dom@valliance.ai' };

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  ontology = new OntologyRepository(db);
  const sourceRef = { system: 'graph' as const, id: 'seed', observedAt: NOW };
  await ontology.upsertOrganisation(
    { name: 'Client Ltd', domains: ['client.test'], type: 'client', sourceRef },
    { correlationId },
  );
  await ontology.upsertOrganisation(
    { name: 'Vendor Ltd', domains: ['vendor.test'], type: 'vendor', sourceRef },
    { correlationId },
  );
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(observations);
});

describe('clientMailUnansweredDetector', () => {
  it('runs hourly', () => {
    expect(clientMailUnansweredDetector.schedule).toBe('0 * * * *');
  });

  it('raises a P1 keyed on the thread when a client has waited three working days', async () => {
    const hash = await observe({
      id: 'm-waiting',
      conversationId: 'conv-waiting',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: ann,
    });

    const alerts = await clientMailUnansweredDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'client_mail_unanswered',
      severity: 'P1',
      dedupeKey: 'thread:conv-waiting',
    });
    expect(alerts[0]?.title).toBe('No reply to Ann Example after 3 working days');
    expect(alerts[0]?.body).toContain('Suggested action');
    expect(alerts[0]?.provenance).toEqual([
      {
        system: 'graph',
        recordId: 'm-waiting',
        hash,
        observedAt: '2026-09-21T09:00:00.000Z',
      },
    ]);
  });

  it('stays quiet once something has been sent on the thread', async () => {
    await observe({
      id: 'm-asked',
      conversationId: 'conv-replied',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: ann,
    });
    await observe({
      id: 'm-answered',
      conversationId: 'conv-replied',
      folder: 'sentitems',
      at: '2026-09-22T09:00:00.000Z',
      from: dom,
    });
    expect(await clientMailUnansweredDetector.run(context())).toEqual([]);
  });

  it('still raises when the only sent message predates the question', async () => {
    await observe({
      id: 'm-earlier-reply',
      conversationId: 'conv-stale',
      folder: 'sentitems',
      at: '2026-09-18T09:00:00.000Z',
      from: dom,
    });
    await observe({
      id: 'm-asked-again',
      conversationId: 'conv-stale',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: ann,
    });
    const alerts = await clientMailUnansweredDetector.run(context());
    expect(alerts.map((alert) => alert.dedupeKey)).toEqual(['thread:conv-stale']);
  });

  it('waits until three working days have passed', async () => {
    await observe({
      id: 'm-recent',
      conversationId: 'conv-recent',
      folder: 'inbox',
      at: '2026-09-22T09:00:00.000Z',
      from: ann,
    });
    expect(await clientMailUnansweredDetector.run(context())).toEqual([]);
  });

  it('counts weekdays only, so a Thursday message is not late the following Monday', async () => {
    await observe({
      id: 'm-thursday',
      conversationId: 'conv-weekend',
      folder: 'inbox',
      at: '2026-09-17T09:00:00.000Z',
      from: ann,
    });
    const alerts = await clientMailUnansweredDetector.run({
      ...context(),
      now: () => '2026-09-21T12:00:00.000Z',
    });
    expect(alerts.map((alert) => alert.dedupeKey)).toEqual([]);
  });

  it('leaves an external domain the ontology does not know alone', async () => {
    await observe({
      id: 'm-stranger',
      conversationId: 'conv-stranger',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: { name: 'Pat Prospect', address: 'pat@unknown.test' },
    });
    expect(await clientMailUnansweredDetector.run(context())).toEqual([]);
  });

  it('leaves vendors, colleagues and public provider addresses alone', async () => {
    await observe({
      id: 'm-vendor',
      conversationId: 'conv-vendor',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: { name: 'Vic Vendor', address: 'vic@vendor.test' },
    });
    await observe({
      id: 'm-colleague',
      conversationId: 'conv-colleague',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: { name: 'Ronan Colleague', address: 'ronan@valliance.ai' },
    });
    await observe({
      id: 'm-personal',
      conversationId: 'conv-personal',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: { name: 'Old Friend', address: 'friend@gmail.com' },
    });
    expect(await clientMailUnansweredDetector.run(context())).toEqual([]);
  });

  it('reports the newest unanswered message on a thread once', async () => {
    await observe({
      id: 'm-first',
      conversationId: 'conv-nudge',
      folder: 'inbox',
      at: '2026-09-18T09:00:00.000Z',
      from: ann,
      subject: 'Revised SOW',
    });
    await observe({
      id: 'm-nudge',
      conversationId: 'conv-nudge',
      folder: 'inbox',
      at: '2026-09-21T09:00:00.000Z',
      from: ann,
      subject: 'Re: Revised SOW',
    });
    const alerts = await clientMailUnansweredDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('Re: Revised SOW');
  });
});
