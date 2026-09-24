import type { ProposalDraft } from '@lance/agents';
import {
  SEED_PRINCIPAL_ID,
  agentRuns,
  cursors,
  proposals,
  runMigrations,
  type Db,
} from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter, SystemControl } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { seedRuleId, seedRules } from '@lance/policy';
import { hashRecord, idempotencyKey, loadConfig, newUlid, nowIso, stableUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { critique } from '../critic/index.js';
import { createProposalHandler, type ProposalContext } from '../executor/createProposal.js';
import type { TriageJob } from '../watchers/runner.js';
import {
  AI_FILED_FOLDER,
  BULK_MAIL_ACTOR,
  bulkFilingDrafts,
  createMailRouter,
  fileBulkMail,
  observedEventsOf,
  routeMail,
} from './bulk.js';
import { TRIAGE_ACTOR, proposalContextFor } from './run.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let control: SystemControl;
let ontology: OntologyRepository;

const CHANNEL = 'C0BU7P278N5';
const rules = seedRules({ slackChannelId: CHANNEL, createdAt: '2026-09-21T00:00:00.000Z' });
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
});
const posted: string[] = [];
const executed: string[] = [];

const createProposal = (): ReturnType<typeof createProposalHandler> =>
  createProposalHandler({
    db,
    config,
    control,
    loadRules: () => Promise.resolve(rules),
    critique: (draft) =>
      critique(draft, { permittedNotionProperties: config.notion.permittedTaskProperties }),
    slack: {
      channelId: CHANNEL,
      post: (input) => {
        posted.push(input.text);
        return Promise.resolve({ channel: CHANNEL, ts: `${String(posted.length)}.0` });
      },
    },
    enqueueExecute: (id) => {
      executed.push(id);
      return Promise.resolve();
    },
  });

interface MailFixture {
  labels: string[];
  from?: string;
  folder?: 'inbox' | 'sentitems';
}

/** Records one graph-mail observation as the watcher runner does and returns the job it would enqueue. */
async function observe(fixture: MailFixture): Promise<TriageJob> {
  const recordId = `AAMk-${newUlid()}`;
  const conversation = `conv-${recordId}`;
  const correlationId = stableUlid(`graph:${conversation}`);
  const record = {
    id: recordId,
    conversationId: conversation,
    subject: 'This week in retail analytics',
    from: { name: 'Sender', address: fixture.from ?? 'news@vendor-news.example' },
    bodyText: 'The week in review.',
    folder: fixture.folder ?? 'inbox',
    removed: false,
  };
  const hash = hashRecord(record);
  const event = await new LedgerWriter(db).append({
    ts: nowIso(),
    actor: 'agent:watcher-graph-mail@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: recordId,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('graph', recordId, hash),
    correlationId,
    payload: {
      ...record,
      summary: 'Sender: This week in retail analytics',
      labels: fixture.labels,
      url: `https://outlook.office.com/mail/${recordId}`,
      watcher: 'graph-mail',
    },
  });
  return { watcher: 'graph-mail', correlationId, observationEventIds: [event.id] };
}

/** Where the router sent one job. */
async function routed(job: TriageJob): Promise<'triage' | 'bulk'> {
  let to: 'triage' | 'bulk' | null = null;
  const router = createMailRouter({
    db,
    config,
    ontology,
    sendTriage: () => {
      to = 'triage';
      return Promise.resolve();
    },
    sendBulk: () => {
      to = 'bulk';
      return Promise.resolve();
    },
  });
  await router(job);
  if (to === null) throw new Error('The router sent the job nowhere.');
  return to;
}

const rowsOf = async (ids: readonly string[]) =>
  ids.length === 0 ? [] : db.select().from(proposals).where(inArray(proposals.id, ids));

/** The fields policy and the routing decide, for comparing two proposals of one action. */
const decided = (row: typeof proposals.$inferSelect) => ({
  actionClass: row.actionClass,
  counterpartyClass: row.counterpartyClass,
  targetSystem: row.targetSystem,
  targetRecordId: row.targetRecordId,
  reversibility: row.reversibility,
  payload: row.payload,
  provenance: row.provenance,
  policyDecision: row.policyDecision,
  policyRuleId: row.policyRuleId,
  status: row.status,
  decidedBy: row.decidedBy,
  decisionNote: row.decisionNote,
  slackTs: row.slackTs === null ? null : 'posted',
});

/**
 * What triage's model would submit through create_proposal for the same
 * message, in the context triage builds: the same drafts, proposed by the
 * triage actor. The comparison shows policy, the critic and the routing
 * treat the filer's proposals as they treat triage's.
 */
async function asTriageWouldPropose(job: TriageJob): Promise<string[]> {
  const events = await observedEventsOf(db, job);
  const context: ProposalContext = await proposalContextFor(
    { db, config, now: nowIso },
    { ...job, correlationId: newUlid() },
    events,
    TRIAGE_ACTOR,
  );
  const drafts: ProposalDraft[] = events.flatMap((event) => bulkFilingDrafts(event));
  const ids: string[] = [];
  for (const draft of drafts) ids.push((await createProposal()(draft, context)).proposalId);
  return ids;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  control = new SystemControl(db);
  ontology = new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID });
  await ontology.upsertOrganisation(
    {
      name: 'Client Retail',
      domains: ['client-retail.example'],
      type: 'client',
      sourceRef: { system: 'graph', id: 'fixture', observedAt: nowIso() },
    },
    { correlationId: newUlid(), actor: 'user:dom' },
  );
  await ontology.upsertOrganisation(
    {
      name: 'Prospect Foods',
      domains: ['prospect-foods.example'],
      type: 'prospect',
      sourceRef: { system: 'graph', id: 'fixture', observedAt: nowIso() },
    },
    { correlationId: newUlid(), actor: 'user:dom' },
  );
}, 120_000);

beforeEach(async () => {
  await control.resume({ actor: 'user:dom' });
  await control.setMode('live', { actor: 'user:dom' });
  await db.delete(cursors).where(eq(cursors.watcher, 'graph-mail'));
});

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('routeMail', () => {
  const none = {
    bulkLabels: config.triage.bulkLabels,
    organisationTypeOf: () => Promise.resolve(null),
  };
  const mail = (labels: string[], extra: Record<string, unknown> = {}) => ({
    payload: {
      watcher: 'graph-mail',
      folder: 'inbox',
      removed: false,
      labels,
      from: { address: 'news@vendor-news.example' },
      ...extra,
    },
  });

  it('routes a thread labelled only Newsletters or Notifications around triage', async () => {
    const route = await routeMail(none, [mail(['Newsletters']), mail(['Notifications'])]);
    expect(route).toMatchObject({ route: 'bulk', labels: ['Newsletters', 'Notifications'] });
  });

  it('sends a message with a bulk and a non-bulk label to triage', async () => {
    expect(await routeMail(none, [mail(['Newsletters', 'Deals'])])).toMatchObject({
      route: 'triage',
      reason: 'a message is labelled Deals',
    });
  });

  it('sends a bulk message the labeller flagged for risk language to triage', async () => {
    expect((await routeMail(none, [mail(['Notifications', 'Risk'])])).route).toBe('triage');
  });

  it('sends a thread with one non-bulk message among bulk ones to triage', async () => {
    expect((await routeMail(none, [mail(['Newsletters']), mail(['Action'])])).route).toBe('triage');
  });

  it('sends sent mail, removals and unlabelled mail to triage as before', async () => {
    expect((await routeMail(none, [mail(['Newsletters'], { folder: 'sentitems' })])).route).toBe(
      'triage',
    );
    expect((await routeMail(none, [mail(['Newsletters'], { removed: true })])).route).toBe(
      'triage',
    );
    expect((await routeMail(none, [mail([])])).route).toBe('triage');
  });

  it('honours a configured bulk set', async () => {
    const alerts = { ...none, bulkLabels: ['Alerts'] };
    expect((await routeMail(alerts, [mail(['Alerts'])])).route).toBe('bulk');
    expect((await routeMail(alerts, [mail(['Newsletters'])])).route).toBe('triage');
  });

  it('sends bulk mail from a client or prospect domain to triage and files a vendor', async () => {
    const types: Record<string, string> = {
      'client.example': 'client',
      'prospect.example': 'prospect',
      'vendor.example': 'vendor',
    };
    const lookup = {
      ...none,
      organisationTypeOf: (domain: string) => Promise.resolve(types[domain] ?? null),
    };
    const from = (address: string) => mail(['Newsletters'], { from: { address } });
    expect(await routeMail(lookup, [from('news@client.example')])).toMatchObject({
      route: 'triage',
      reason: "the sender's domain client.example is a client",
    });
    expect((await routeMail(lookup, [from('news@prospect.example')])).route).toBe('triage');
    expect((await routeMail(lookup, [from('news@vendor.example')])).route).toBe('bulk');
  });
});

describe('the mail router over the ledger and the ontology', () => {
  it('sends a bulk-only message to the filer', async () => {
    expect(await routed(await observe({ labels: ['Newsletters'] }))).toBe('bulk');
  });

  it('sends a message with a bulk and a non-bulk label to triage', async () => {
    expect(await routed(await observe({ labels: ['Newsletters', 'Priority'] }))).toBe('triage');
  });

  it('sends a message from a client or prospect domain to triage whatever its label', async () => {
    const client = await observe({
      labels: ['Newsletters'],
      from: 'updates@client-retail.example',
    });
    const prospect = await observe({
      labels: ['Notifications'],
      from: 'noreply@prospect-foods.example',
    });
    expect(await routed(client)).toBe('triage');
    expect(await routed(prospect)).toBe('triage');
  });

  it('sends every other watcher to triage without reading its observations', async () => {
    let to: string | null = null;
    const router = createMailRouter({
      db,
      config,
      ontology,
      sendTriage: () => {
        to = 'triage';
        return Promise.resolve();
      },
      sendBulk: () => Promise.reject(new Error('not bulk')),
    });
    await router({ watcher: 'jamie', correlationId: newUlid(), observationEventIds: [] });
    expect(to).toBe('triage');
  });
});

describe('fileBulkMail', () => {
  it('files a bulk-only message without a model call, as triage would under the seed rules', async () => {
    const job = await observe({ labels: ['Newsletters'] });
    const result = await fileBulkMail({ db, config, createProposal: createProposal() }, job);

    const filed = await rowsOf(result.proposalIds);
    expect(filed.map((row) => [row.actionClass, row.status, row.policyRuleId])).toEqual([
      ['apply_category', 'approved', seedRuleId(3)],
      ['move_mail', 'approved', seedRuleId(4)],
    ]);
    expect(executed).toEqual(expect.arrayContaining(result.proposalIds));
    const [category, move] = filed;
    expect(category?.payload).toEqual({ categories: ['Newsletters'] });
    expect(move?.payload).toEqual({
      destinationFolderName: AI_FILED_FOLDER,
      sourceFolderId: 'inbox',
    });
    expect(category?.preview).toBe('Apply category Newsletters to "This week in retail analytics"');
    expect(move?.preview).toBe('Move "This week in retail analytics" from Inbox to AI-Filed');
    for (const row of filed) {
      expect(row.rationale).toContain('ADR 0034');
      expect(row.provenance).toEqual([
        expect.objectContaining({
          system: 'graph',
          recordId: row.targetRecordId,
          hash: expect.any(String) as unknown,
          observedAt: expect.any(String) as unknown,
          url: expect.stringContaining('outlook') as unknown,
        }),
      ]);
    }

    const triaged = await rowsOf(await asTriageWouldPropose(job));
    expect(filed.map(decided)).toEqual(triaged.map(decided));

    // No model ran: no agent run and no cost on the thread's trail.
    const runs = await db.select().from(agentRuns);
    expect(runs).toEqual([]);
    const trail = await new LedgerReader(db).byCorrelation(job.correlationId);
    expect(trail.filter((event) => event.kind === 'cost_recorded')).toEqual([]);
  });

  it('records in the ledger that the message was routed around triage and why', async () => {
    const job = await observe({ labels: ['Notifications'] });
    const result = await fileBulkMail({ db, config, createProposal: createProposal() }, job);
    const trail = await new LedgerReader(db).byCorrelation(job.correlationId);
    const resolved = trail.filter((event) => event.kind === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.actor).toBe(BULK_MAIL_ACTOR);
    expect(resolved[0]?.payload).toMatchObject({
      kind: 'bulk_mail',
      routedAroundTriage: true,
      labels: ['Notifications'],
      bulkLabels: ['Newsletters', 'Notifications'],
      proposalIds: result.proposalIds,
      observationEventIds: job.observationEventIds,
      watcherDryRun: false,
    });
    expect((resolved[0]?.payload as { reason: string }).reason).toContain(
      'labelled only Notifications, all in the bulk set',
    );
  });

  it('proposes nothing twice when a job is retried', async () => {
    const job = await observe({ labels: ['Newsletters'] });
    const first = await fileBulkMail({ db, config, createProposal: createProposal() }, job);
    const second = await fileBulkMail({ db, config, createProposal: createProposal() }, job);
    expect(second.proposalIds).toEqual(first.proposalIds);
    const rows = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.correlationId, job.correlationId));
    expect(rows).toHaveLength(2);
  });

  it("holds its proposals in dry run exactly as it holds triage's", async () => {
    await control.setMode('dry_run', { actor: 'user:dom' });
    const before = { executed: executed.length, posted: posted.length };
    const job = await observe({ labels: ['Newsletters'] });
    const filed = await rowsOf(
      (await fileBulkMail({ db, config, createProposal: createProposal() }, job)).proposalIds,
    );
    const triaged = await rowsOf(await asTriageWouldPropose(job));
    expect(filed.map((row) => row.status)).toEqual(['held', 'held']);
    expect(filed.map(decided)).toEqual(triaged.map(decided));
    expect(executed).toHaveLength(before.executed);
    expect(posted).toHaveLength(before.posted);
  });

  it("holds its proposals while the mail watcher is in its dry-run window, as triage's are", async () => {
    const startedAt = nowIso();
    await db.insert(cursors).values({
      watcher: 'graph-mail',
      key: '__started_at',
      value: startedAt,
      updatedAt: new Date(startedAt),
    });
    const job = await observe({ labels: ['Notifications'] });
    const filed = await rowsOf(
      (await fileBulkMail({ db, config, createProposal: createProposal() }, job)).proposalIds,
    );
    const triaged = await rowsOf(await asTriageWouldPropose(job));
    expect(filed.map((row) => row.status)).toEqual(['held', 'held']);
    expect(filed.map(decided)).toEqual(triaged.map(decided));
  });

  it("holds its approved proposals under the kill switch exactly as triage's", async () => {
    const job = await observe({ labels: ['Newsletters'] });
    const filedIds = (await fileBulkMail({ db, config, createProposal: createProposal() }, job))
      .proposalIds;
    const triagedIds = await asTriageWouldPropose(job);
    expect((await rowsOf([...filedIds, ...triagedIds])).map((row) => row.status)).toEqual([
      'approved',
      'approved',
      'approved',
      'approved',
    ]);
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    const filed = await rowsOf(filedIds);
    const triaged = await rowsOf(triagedIds);
    expect(filed.map((row) => row.status)).toEqual(['held', 'held']);
    expect(filed.map((row) => row.status)).toEqual(triaged.map((row) => row.status));
  });

  it('refuses a job that names no observed events', async () => {
    await expect(
      fileBulkMail(
        { db, config, createProposal: createProposal() },
        { watcher: 'graph-mail', correlationId: newUlid(), observationEventIds: [newUlid()] },
      ),
    ).rejects.toThrow(/names no observed events/);
  });
});

describe('the filer and the executor', () => {
  it('leaves the ledger trail of a filed message as proposed and decided events only', async () => {
    const job = await observe({ labels: ['Newsletters'] });
    await fileBulkMail({ db, config, createProposal: createProposal() }, job);
    const trail = await new LedgerReader(db).byCorrelation(job.correlationId);
    expect(
      trail.filter((event) => event.kind !== 'observed').map((event) => [event.kind, event.actor]),
    ).toEqual([
      ['proposed', BULK_MAIL_ACTOR],
      ['decided', 'system:policy'],
      ['proposed', BULK_MAIL_ACTOR],
      ['decided', 'system:policy'],
      ['resolved', BULK_MAIL_ACTOR],
    ]);
    const rows = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(and(eq(proposals.correlationId, job.correlationId), eq(proposals.status, 'approved')));
    expect(rows).toHaveLength(2);
  });
});
