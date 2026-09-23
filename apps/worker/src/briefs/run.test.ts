import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import { briefs, commitments, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import {
  AfternoonBoardContentSchema,
  MorningBriefContentSchema,
  hashRecord,
  idempotencyKey,
  loadConfig,
  stableUlid,
} from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleMorningBrief } from './data.js';
import { applyPlan } from './planner.js';
import { runAfternoonBoard, runMeetingPrep, runMorningBrief, type BriefDeps } from './run.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;
const posts: { text: string; threadTs?: string; ts: string }[] = [];
let counter = 0;

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
  ALLOWED_UPN: 'dom@valliance.ai',
});

/** 09:00 BST on Tuesday 22 September 2026. */
const NOW = '2026-09-22T08:00:00.000Z';

async function observe(
  watcher: string,
  system: 'graph' | 'jamie' | 'notion',
  recordId: string,
  record: Record<string, unknown>,
  ts = NOW,
) {
  const hash = hashRecord(record);
  await new LedgerWriter(db).append({
    ts,
    actor: `agent:watcher-${watcher}@0.1.0`,
    kind: 'observed',
    sourceSystem: system,
    sourceRecordId: recordId,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey(system, recordId, hash),
    correlationId: stableUlid(`${system}:${recordId}`),
    payload: { ...record, watcher },
  });
}

function deps(overrides: Partial<BriefDeps> = {}): BriefDeps {
  return {
    db,
    config,
    ontology,
    agent: null,
    reads: {
      searchLedger: () => Promise.resolve([]),
      getSourceRecord: () => Promise.resolve(null),
      lookupEntity: () => Promise.resolve([]),
    },
    slack: {
      post: (input) => {
        const ts = `1.${String(++counter)}`;
        posts.push({
          text: input.text,
          ts,
          ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }),
        });
        return Promise.resolve({ channel: 'C1', ts });
      },
    },
    createProposal: () => Promise.reject(new Error('no proposals in this test')),
    now: () => NOW,
    ...overrides,
  };
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  ontology = new OntologyRepository(db);

  await observe('graph-calendar', 'graph', 'evt-1', {
    id: 'evt-1',
    subject: 'Kick-off with Client Ltd',
    start: { dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'GMT Standard Time' },
    end: { dateTime: '2026-09-22T11:00:00.0000000', timeZone: 'GMT Standard Time' },
    isAllDay: false,
    isCancelled: false,
    organizer: { name: 'Dom Selvon', address: 'dom@valliance.ai' },
    attendees: [
      {
        name: 'Ann Example',
        address: 'ann@client.test',
        type: 'required',
        responseStatus: 'accepted',
      },
      {
        name: 'Dom Selvon',
        address: 'dom@valliance.ai',
        type: 'required',
        responseStatus: 'organizer',
      },
      {
        name: 'Bob Colleague',
        address: 'bob@valliance.ai',
        type: 'required',
        responseStatus: 'accepted',
      },
    ],
    url: 'https://outlook.test/evt-1',
    removed: false,
  });
  await observe('graph-calendar', 'graph', 'evt-2', {
    id: 'evt-2',
    subject: 'Tomorrow planning',
    start: { dateTime: '2026-09-23T09:00:00.0000000', timeZone: 'GMT Standard Time' },
    end: { dateTime: '2026-09-23T09:30:00.0000000', timeZone: 'GMT Standard Time' },
    isAllDay: false,
    isCancelled: false,
    organizer: null,
    attendees: [],
    removed: false,
  });
  await observe('notion', 'notion', 'page-1', {
    kind: 'task',
    title: 'Send the SOW',
    status: 'In progress',
    assigneeIds: [config.notion.domUserId],
    due: '2026-09-21',
    url: 'https://notion.test/page-1',
  });
  // A colleague's overdue task: the All Tasks DB holds the whole company's
  // work and the brief shows only Dom's.
  await observe('notion', 'notion', 'page-2', {
    kind: 'task',
    title: 'Legal review',
    status: 'Not Started',
    assigneeIds: ['00000000-0000-4000-8000-000000000002'],
    due: '2026-07-09',
    url: 'https://notion.test/page-2',
  });
  // Dom's overdue task whose page was later moved to the trash.
  await observe(
    'notion',
    'notion',
    'page-3',
    {
      kind: 'task',
      title: 'Draft the agenda',
      status: 'Not Started',
      assigneeIds: [config.notion.domUserId],
      due: '2026-09-22',
      url: 'https://notion.test/page-3',
    },
    '2026-09-20T09:00:00.000Z',
  );
  await observe(
    'notion',
    'notion',
    'page-3',
    { kind: 'task', id: 'page-3', removed: true },
    '2026-09-21T09:00:00.000Z',
  );
  // A delegated Jamie item that is not Dom's.
  await observe('jamie', 'jamie', 'jt-1', {
    kind: 'task',
    text: 'Provide the source data',
    completed: false,
    assignedToDom: false,
  });
  await observe(
    'graph-mail',
    'graph',
    'msg-1',
    {
      subject: 'Re: scope',
      from: { name: 'Ann Example', address: 'ann@client.test' },
      folder: 'inbox',
      summary: 'Ann Example: Re: scope',
    },
    '2026-09-20T09:00:00.000Z',
  );
  const ann = await ontology.upsertPerson(
    {
      displayName: 'Ann Example',
      emails: ['ann@client.test'],
      sourceRef: { system: 'graph', id: 'msg-1', observedAt: NOW },
    },
    { correlationId: stableUlid('test') },
  );
  const dom = await ontology.upsertPerson(
    {
      displayName: 'Dom Selvon',
      emails: ['dom@valliance.ai'],
      isInternal: true,
      sourceRef: { system: 'lance', id: 'dom', observedAt: NOW },
    },
    { correlationId: stableUlid('test') },
  );
  await db.insert(commitments).values({
    id: stableUlid('commitment-1'),
    direction: 'inbound',
    ownerPersonId: ann.id,
    counterpartyPersonId: dom.id,
    description: 'Confirm the start date',
    dueAt: new Date('2026-09-18T00:00:00.000Z'),
    dueConfidence: 1,
    evidenceQuote: 'I will confirm the start date',
    sourceRefs: [{ system: 'jamie', recordId: 'mt-1', hash: 'h', observedAt: NOW }],
    status: 'open',
    nextChaseAt: new Date('2026-09-20T00:00:00.000Z'),
  });
  // Cara is at the client but not in the meeting: her commitment belongs in
  // the prep. Bob is a colleague in the meeting: what Dom owes him from
  // their own catch-up does not.
  const cara = await ontology.upsertPerson(
    {
      displayName: 'Cara Example',
      emails: ['cara@client.test'],
      sourceRef: { system: 'graph', id: 'msg-2', observedAt: NOW },
    },
    { correlationId: stableUlid('test') },
  );
  const bob = await ontology.upsertPerson(
    {
      displayName: 'Bob Colleague',
      emails: ['bob@valliance.ai'],
      isInternal: true,
      sourceRef: { system: 'graph', id: 'evt-1', observedAt: NOW },
    },
    { correlationId: stableUlid('test') },
  );
  await db.insert(commitments).values([
    {
      id: stableUlid('commitment-2'),
      direction: 'outbound',
      ownerPersonId: dom.id,
      counterpartyPersonId: cara.id,
      description: 'Send Cara the deck',
      dueAt: null,
      dueConfidence: 0,
      evidenceQuote: 'I will send you the deck',
      sourceRefs: [{ system: 'graph', recordId: 'msg-2', hash: 'h', observedAt: NOW }],
      status: 'open',
      nextChaseAt: null,
    },
    {
      id: stableUlid('commitment-3'),
      direction: 'outbound',
      ownerPersonId: dom.id,
      counterpartyPersonId: bob.id,
      description: 'Review the draft ISO policy',
      dueAt: null,
      dueConfidence: 0,
      evidenceQuote: 'I will review the draft',
      sourceRefs: [{ system: 'jamie', recordId: 'mt-2', hash: 'h', observedAt: NOW }],
      status: 'open',
      nextChaseAt: null,
    },
  ]);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('assembleMorningBrief', () => {
  it("lists today's meeting with its resolved attendee, recent mail, open commitment, the overdue task and the waiting-for line in the shared shape", async () => {
    const { content: brief, freeTimeShort } = await assembleMorningBrief({
      db,
      ontology,
      config,
      now: () => NOW,
    });
    expect(MorningBriefContentSchema.safeParse(brief).success).toBe(true);
    expect(brief.date).toBe('2026-09-22');
    expect(brief.headline).toBe('1 meeting, 1 external. 1 task overdue. 1 waiting on others.');
    expect(brief.meetings.map((m) => m.title)).toEqual(['Kick-off with Client Ltd']);
    const meeting = brief.meetings[0]!;
    expect(meeting.audience).toBe('external');
    expect(meeting.counterpartyClass).toBe('unknown');
    expect(meeting.attendees.map((a) => [a.name, a.unknown])).toEqual([
      ['Ann Example', false],
      ['Bob Colleague', false],
    ]);
    expect(meeting.attendees[0]?.interactions[0]).toMatchObject({
      kind: 'mail',
      summary: 'Ann Example: Re: scope',
    });
    // The client's people, in the room or not; never a colleague's own commitments.
    expect(meeting.commitments.map((c) => c.description).sort()).toEqual([
      'Confirm the start date',
      'Send Cara the deck',
    ]);
    expect(meeting.provenance).toMatchObject({ system: 'graph', recordId: 'evt-1' });
    expect(meeting.prepExpandsAt).toBe('2026-09-22T08:30:00.000Z');
    // Only Dom's live tasks: not the colleague's, not the trashed page, not the delegated Jamie item.
    expect(brief.tasks.items.map((t) => [t.title, t.overdueDays])).toEqual([['Send the SOW', 1]]);
    expect(brief.tasks.total).toBe(1);
    expect(brief.waitingFor[0]).toMatchObject({
      counterparty: 'Ann Example',
      overdueDays: 4,
      chaseCount: 0,
      pendingChaseProposalId: null,
    });
    expect(brief.dayShape).toMatchObject({ meetingHours: 1, workingHours: 10 });
    expect(brief.dayShape.longestFreeBlock?.hours).toBe(7);
    expect(freeTimeShort).toBe(false);
    expect(brief.dayShape.note).toContain('no hold is proposed');
  });
});

describe('runMorningBrief', () => {
  it("applies the planner's objectives and ranking, posts a parent with threaded sections, stores the validated brief and records the ledger", async () => {
    const runner = new ScriptedRunner([
      [
        textMessage(
          JSON.stringify({
            meetings: [{ id: 'evt-1', objectives: ['Agree the start date.', 'Close the SOW.'] }],
            tasks: [
              {
                taskId: 'notion:page-1',
                rank: 1,
                reason: 'Ann is waiting on it and you meet at ten.',
              },
            ],
            holdsProposed: 0,
          }),
        ),
      ],
    ]);
    const result = await runMorningBrief(
      deps({
        agent: {
          runner,
          recorder: new MemoryRunRecorder(),
          ledger: new LedgerWriter(db),
          config: { prices: config.prices, cost: config.cost },
          readSpendUsd: () => Promise.resolve(0),
        },
      }),
    );
    const stored = (await db.select().from(briefs).where(eq(briefs.id, result.briefId)))[0];
    expect(stored?.kind).toBe('morning_brief');
    const parsed = MorningBriefContentSchema.parse(stored?.content);
    const extras = stored?.content as { slackThreads: Record<string, string>; slackTs: string };
    expect(parsed.meetings[0]?.objectives).toEqual(['Agree the start date.', 'Close the SOW.']);
    expect(parsed.tasks.items[0]?.reason).toContain('Ann is waiting');
    expect(extras.slackThreads['evt-1']).toBeDefined();
    expect(extras.slackTs).toBe(result.slackTs);
    expect(stored?.markdown).toContain('# Morning brief, 2026-09-22');
    const parent = posts.find((p) => p.ts === result.slackTs);
    expect(parent?.text).toContain('morning brief, 2026-09-22');
    expect(posts.filter((p) => p.threadTs === result.slackTs).length).toBeGreaterThanOrEqual(5);
    const trail = await new LedgerReader(db).byCorrelation(result.correlationId);
    expect(trail.some((e) => (e.payload as { kind?: string } | null)?.kind === 'brief')).toBe(true);
    expect(runner.calls[0]?.tools.map((t) => ('name' in t ? t.name : ''))).toContain(
      'create_proposal',
    );
  });

  it('ignores planner ids that are not in the brief and drops lines that fail the voice checks', () => {
    const brief = {
      meetings: [
        { id: 'evt-1', objectives: [] },
        { id: 'evt-2', objectives: [] },
      ],
      tasks: { items: [{ taskId: 'a', reason: '' }], total: 1, duplicatesMerged: 0 },
    } as never;
    const out = applyPlan(brief, {
      meetings: [
        { id: 'ghost', objectives: ['x'] },
        { id: 'evt-2', objectives: ['Fine.', 'Not only this but also that.'] },
      ],
      tasks: [{ taskId: 'ghost', rank: 1, reason: 'no' }],
      holdsProposed: 0,
    });
    expect(out.meetings[0]?.objectives).toEqual([]);
    expect(out.meetings[1]?.objectives).toEqual(['Fine.']);
    expect(out.tasks.items).toHaveLength(1);
  });
});

describe('runAfternoonBoard and runMeetingPrep', () => {
  it("reports what is pending and tomorrow's first meeting, and writes one prep under the brief thread within the lead time", async () => {
    const board = await runAfternoonBoard(deps({ now: () => '2026-09-22T15:00:00.000Z' }));
    const stored = (await db.select().from(briefs).where(eq(briefs.id, board.briefId)))[0];
    const content = AfternoonBoardContentSchema.parse(stored?.content);
    expect(content.tomorrowFirstMeeting?.title).toBe('Tomorrow planning');
    expect(content.tomorrowFirstMeeting?.audience).toBe('internal');
    expect(content.tomorrowFirstMeeting?.prepExists).toBe(false);
    expect(content.moved.proposalsDecided).toEqual({ approved: 0, edited: 0, rejected: 0 });

    // 09:35 BST, 25 minutes before the external kick-off.
    const preps = await runMeetingPrep(deps({ now: () => '2026-09-22T08:35:00.000Z' }));
    expect(preps).toHaveLength(1);
    const prep = posts.find((p) => p.ts === preps[0]?.slackTs);
    expect(prep?.text).toContain('Prep: Kick-off with Client Ltd');
    expect(prep?.text).toContain('Open:\n- Owed to you: Confirm the start date (4 days overdue)');
    expect(prep?.text).toContain('- You owe: Send Cara the deck');
    expect(prep?.text).not.toContain('ISO policy');
    expect(prep?.threadTs).toBeDefined();
    const again = await runMeetingPrep(deps({ now: () => '2026-09-22T08:40:00.000Z' }));
    expect(again).toHaveLength(0);
  });
});
