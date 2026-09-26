import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import type { ProposalDraft } from '@lance/agents';
import { alerts, SEED_PRINCIPAL_ID, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { hashRecord, idempotencyKey, loadConfig, stableUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTriage, taskDraft, workingDaysBetween } from './run.js';

let container: StartedPostgreSqlContainer;
let db: Db;
const correlationId = stableUlid('graph:conv-1');
const created: Array<{ draft: ProposalDraft; context: unknown }> = [];

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
});

const agentConfig = {
  prices: {
    'claude-sonnet-5': {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    },
  },
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.78 },
};

async function observe(recordId: string, record: Record<string, unknown>): Promise<string> {
  const hash = hashRecord(record);
  const result = await new LedgerWriter(db).append({
    ts: '2026-09-21T08:00:00.000Z',
    actor: 'agent:watcher-graph-mail@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: recordId,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('graph', recordId, hash),
    correlationId,
    payload: {
      ...record,
      labels: ['Deals'],
      summary: 'A client asks for a revised SOW',
      watcher: 'graph-mail',
    },
  });
  return result.id;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('workingDaysBetween', () => {
  it('counts weekdays only', () => {
    expect(
      workingDaysBetween(new Date('2026-09-18T09:00:00Z'), new Date('2026-09-21T09:00:00Z')),
    ).toBe(1);
    expect(
      workingDaysBetween(new Date('2026-09-14T09:00:00Z'), new Date('2026-09-21T09:00:00Z')),
    ).toBe(5);
  });
});

describe('taskDraft', () => {
  it('puts a delegate in brackets in the title and keeps Dom as assignee', () => {
    const draft = taskDraft(
      {
        title: 'Send revised SOW',
        description: null,
        dueDate: '2026-09-25',
        assigneeName: 'Alice Smith',
        priority: 'High',
        evidenceQuote: 'please send the revised SOW by Friday',
        recordId: 'm1',
      },
      [{ system: 'graph', recordId: 'm1', hash: 'h', observedAt: '2026-09-21T08:00:00.000Z' }],
      config.notion,
      config.notion.domUserId,
    );
    expect(draft.actionClass).toBe('create_task');
    expect(draft.counterpartyClass).toBe('internal');
    const input = draft.payload['input'] as Record<string, unknown>;
    expect(input['title']).toBe('Send revised SOW (Alice Smith)');
    expect(input['assigneeIds']).toEqual([config.notion.domUserId]);
    expect(input['due']).toBe('2026-09-25');
    expect(draft.payload['delegateName']).toBe('Alice Smith');
    expect(draft.preview).toContain('(Alice Smith)');
  });
});

describe('runTriage', () => {
  it('turns task and alert candidates into a proposal and a P0 alert and records the triage', async () => {
    const eventId = await observe('m1', {
      subject: 'Revised SOW',
      from: 'client@example.com',
      bodyText: 'Please send the revised SOW by Friday. Our legal team is reviewing the contract.',
    });
    const modelOutput = {
      importance: 0.8,
      urgency: 0.7,
      summary: 'Client wants the revised SOW by Friday and legal is reviewing.',
      entities: [
        {
          kind: 'person',
          name: 'Client Person',
          email: 'client@example.com',
          domain: 'example.com',
          confidence: 0.9,
        },
      ],
      commitments: [
        {
          direction: 'outbound',
          description: 'Send revised SOW',
          counterpartyName: 'Client Person',
          counterpartyEmail: 'client@example.com',
          dueAt: '2026-09-25',
          dueConfidence: 0.8,
          evidenceQuote: 'Please send the revised SOW by Friday',
          recordId: 'm1',
        },
      ],
      taskCandidates: [
        {
          title: 'Send revised SOW',
          description: null,
          dueDate: '2026-09-25',
          assigneeName: null,
          priority: 'High',
          evidenceQuote: 'Please send the revised SOW by Friday',
          recordId: 'm1',
        },
      ],
      proposalsSubmitted: 0,
      alertCandidates: [
        {
          kind: 'risk_language_in_client_mail',
          severity: 'P0',
          title: 'Legal is reviewing the contract',
          evidenceQuote: 'Our legal team is reviewing the contract',
          recordId: 'm1',
        },
      ],
    };
    const runner = new ScriptedRunner([[textMessage(JSON.stringify(modelOutput))]]);
    const result = await runTriage(
      {
        db,
        config,
        agent: {
          runner,
          recorder: new MemoryRunRecorder(),
          ledger: new LedgerWriter(db),
          config: agentConfig,
          readSpendUsd: () => Promise.resolve(0),
        },
        createProposal: (draft, context) => {
          created.push({ draft, context });
          return Promise.resolve({
            proposalId: `p-${created.length}`,
            decision: 'propose',
            status: 'pending',
          });
        },
      },
      { watcher: 'graph-mail', correlationId, observationEventIds: [eventId] },
    );
    expect(result.taskProposals).toEqual(['p-1']);
    expect(created[0]?.draft).toMatchObject({ actionClass: 'create_task', targetSystem: 'notion' });
    expect(created[0]?.draft.provenance[0]).toMatchObject({ system: 'graph', recordId: 'm1' });
    expect(created[0]?.context).toMatchObject({
      correlationId,
      labels: ['Deals'],
      watcherDryRun: false,
    });
    expect(result.alerts).toHaveLength(1);
    const alert = (
      await db
        .select()
        .from(alerts)
        .where(eq(alerts.id, result.alerts[0] ?? ''))
    )[0];
    expect(alert).toMatchObject({ kind: 'risk_language_in_client_mail', severity: 'P0' });
    const trail = await new LedgerReader(db).byCorrelation(correlationId);
    expect(trail.map((event) => event.kind).sort()).toEqual([
      'alert_raised',
      'cost_recorded',
      'observed',
      'resolved',
    ]);
    const prompt = runner.calls[0]?.messages[0]?.content;
    expect(JSON.stringify(prompt)).toContain('recordId: m1');
    expect(runner.calls[0]?.tools.map((tool) => ('name' in tool ? tool.name : ''))).toEqual([
      'ledger_search',
      'source_get_record',
      'ontology_lookup',
      'create_proposal',
    ]);
  });

  it("records the extractor's commitments from a transcript and drops the triage model's own reading of it", async () => {
    const meetingCorrelationId = stableUlid('jamie:mt-1');
    const record = {
      kind: 'meeting',
      id: 'mt-1',
      title: 'Ronan / Dom Weekly Catchup',
      startTime: '2026-09-21T09:00:00.000Z',
      endTime: '2026-09-21T09:30:00.000Z',
      participants: [
        { name: 'Dom Selvon', email: 'dom@valliance.ai' },
        { name: 'Ronan Forker', email: 'ronan@valliance.ai' },
      ],
      attendees: [],
      transcript:
        'Ronan: I will send you the resource plan by Friday. I just need to read Matt’s email first.',
      transcriptReady: true,
      domAttended: true,
    };
    const hash = hashRecord(record);
    const observed = await new LedgerWriter(db).append({
      ts: '2026-09-21T10:00:00.000Z',
      actor: 'agent:watcher-jamie@0.1.0',
      kind: 'observed',
      sourceSystem: 'jamie',
      sourceRecordId: 'mt-1',
      sourceRecordHash: hash,
      idempotencyKey: idempotencyKey('jamie', 'mt-1', hash),
      correlationId: meetingCorrelationId,
      payload: {
        ...record,
        labels: ['Meeting', 'TranscriptReady', 'DomAttended'],
        watcher: 'jamie',
      },
    });
    const candidate = (description: string, evidenceQuote: string) => ({
      direction: 'inbound' as const,
      description,
      counterpartyName: 'Ronan Forker',
      counterpartyEmail: 'ronan@valliance.ai',
      dueAt: null,
      dueConfidence: 0,
      evidenceQuote,
      recordId: 'mt-1',
    });
    const modelOutput = {
      importance: 0.4,
      urgency: 0.2,
      summary: 'Ronan will send the resource plan.',
      entities: [],
      commitments: [
        candidate('Ronan to send the resource plan.', 'I will send you the resource plan'),
        candidate('Read Matt’s email before the session', 'I just need to read Matt’s email first'),
      ],
      taskCandidates: [],
      proposalsSubmitted: 0,
      alertCandidates: [],
    };
    const runner = new ScriptedRunner([[textMessage(JSON.stringify(modelOutput))]]);
    const result = await runTriage(
      {
        db,
        config,
        agent: {
          runner,
          recorder: new MemoryRunRecorder(),
          ledger: new LedgerWriter(db),
          config: agentConfig,
          readSpendUsd: () => Promise.resolve(0),
        },
        createProposal: () => Promise.reject(new Error('no proposals in this test')),
        ontology: new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID }),
        principal: { name: 'Dom Selvon', email: 'dom@valliance.ai', notionUserId: null },
        extractCommitments: (source) => {
          expect(source.text).toBe(record.transcript);
          return Promise.resolve([
            candidate('Send the resource plan', 'I will send you the resource plan by Friday'),
          ]);
        },
      },
      { watcher: 'jamie', correlationId: meetingCorrelationId, observationEventIds: [observed.id] },
    );
    expect(result.commitments.map((commitment) => commitment.description)).toEqual([
      'Send the resource plan',
    ]);
  });

  it("keys a Jamie meeting on the iCalUId of the principal's own calendar event and keeps its context on the principal's edge", async () => {
    const ontology = new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID });
    await new LedgerWriter(db).append({
      ts: '2026-09-21T07:00:00.000Z',
      actor: 'agent:watcher-graph-calendar@0.1.0',
      kind: 'observed',
      sourceSystem: 'graph',
      sourceRecordId: 'AAMk-evt-9',
      sourceRecordHash: 'calendar-hash-9',
      idempotencyKey: idempotencyKey('graph', 'AAMk-evt-9', 'calendar-hash-9'),
      correlationId: stableUlid('graph:AAMk-evt-9'),
      payload: { id: 'AAMk-evt-9', iCalUId: 'ical-9', watcher: 'graph-calendar' },
    });
    const triageMeeting = async (id: string, graphEventId: string | null) => {
      const meetingCorrelationId = stableUlid(`jamie:${id}`);
      const record = {
        kind: 'meeting',
        id,
        title: `Northwind review ${id}`,
        startTime: '2026-09-22T09:00:00.000Z',
        endTime: '2026-09-22T09:30:00.000Z',
        participants: [{ name: 'Dom Selvon', email: 'dom@valliance.ai' }],
        attendees: [{ name: 'Priya Raman', email: 'priya@northwind.test' }],
        graphEventId,
        tags: ['Client'],
        transcriptReady: false,
        domAttended: true,
      };
      const hash = hashRecord(record);
      const observed = await new LedgerWriter(db).append({
        ts: '2026-09-22T10:00:00.000Z',
        actor: 'agent:watcher-jamie@0.1.0',
        kind: 'observed',
        sourceSystem: 'jamie',
        sourceRecordId: id,
        sourceRecordHash: hash,
        idempotencyKey: idempotencyKey('jamie', id, hash),
        correlationId: meetingCorrelationId,
        payload: { ...record, labels: ['Meeting'], watcher: 'jamie' },
      });
      const modelOutput = {
        importance: 0.3,
        urgency: 0.1,
        summary: 'A review with Northwind.',
        entities: [],
        commitments: [],
        taskCandidates: [],
        proposalsSubmitted: 0,
        alertCandidates: [],
      };
      await runTriage(
        {
          db,
          config,
          agent: {
            runner: new ScriptedRunner([[textMessage(JSON.stringify(modelOutput))]]),
            recorder: new MemoryRunRecorder(),
            ledger: new LedgerWriter(db),
            config: agentConfig,
            readSpendUsd: () => Promise.resolve(0),
          },
          createProposal: () => Promise.reject(new Error('no proposals in this test')),
          ontology,
        },
        {
          watcher: 'jamie',
          correlationId: meetingCorrelationId,
          observationEventIds: [observed.id],
        },
      );
    };

    await triageMeeting('mt-9', 'AAMk-evt-9');
    const keyed = await ontology.findMeeting({ icalUid: 'ical-9' });
    expect(keyed?.properties['title']).toBe('Northwind review mt-9');
    expect(keyed?.properties).not.toHaveProperty('graph_event_id');
    expect(keyed?.properties).not.toHaveProperty('tags');
    expect(await ontology.meetingContext(keyed?.id ?? '')).toMatchObject({
      graphEventId: 'AAMk-evt-9',
      tags: ['Client'],
      jamieId: 'mt-9',
    });
    expect(await ontology.findMeeting({ jamieId: 'mt-9' })).toMatchObject({ id: keyed?.id });

    await triageMeeting('mt-10', null);
    const unkeyed = await ontology.findMeeting({ jamieId: 'mt-10' });
    expect(unkeyed?.properties['jamie_id']).toBe('mt-10');
    expect(unkeyed?.properties).not.toHaveProperty('ical_uid');
  });

  it('reads a transcript once however often the meeting is observed, and a changed transcript only for what is new', async () => {
    const meetingCorrelationId = stableUlid('jamie:mt-20');
    const transcript = 'Brian: Can you read the SOW? Dom: I will read through the SOW by Friday.';
    const observeMeeting = async (fields: Record<string, unknown>) => {
      const record = {
        kind: 'meeting',
        id: 'mt-20',
        title: 'Brian / Dom',
        startTime: '2026-09-24T12:00:00.000Z',
        endTime: '2026-09-24T12:59:00.000Z',
        participants: [
          { name: 'Dom Selvon', email: 'dom@valliance.ai' },
          { name: 'Brian Vargas-Meinel', email: 'brian@valliance.ai' },
        ],
        attendees: [],
        transcript,
        transcriptReady: true,
        domAttended: true,
        ...fields,
      };
      const hash = hashRecord(record);
      const observed = await new LedgerWriter(db).append({
        ts: '2026-09-24T12:59:00.000Z',
        actor: 'agent:watcher-jamie@0.1.0',
        kind: 'observed',
        sourceSystem: 'jamie',
        sourceRecordId: 'mt-20',
        sourceRecordHash: hash,
        idempotencyKey: idempotencyKey('jamie', 'mt-20', hash),
        correlationId: meetingCorrelationId,
        payload: { ...record, labels: ['Meeting', 'TranscriptReady'], watcher: 'jamie' },
      });
      return observed.id;
    };
    const commitment = (description: string, evidenceQuote: string) => ({
      direction: 'outbound' as const,
      description,
      counterpartyName: 'Brian Vargas-Meinel',
      counterpartyEmail: 'brian@valliance.ai',
      dueAt: null,
      dueConfidence: 0,
      evidenceQuote,
      recordId: 'mt-20',
    });
    const modelOutput = (taskTitle: string) => ({
      importance: 0.4,
      urgency: 0.2,
      summary: 'Dom will read the SOW.',
      entities: [],
      commitments: [commitment(taskTitle, 'I will read through the SOW')],
      taskCandidates: [
        {
          title: taskTitle,
          description: null,
          dueDate: null,
          assigneeName: null,
          priority: null,
          evidenceQuote: 'I will read through the SOW',
          recordId: 'mt-20',
        },
      ],
      proposalsSubmitted: 0,
      alertCandidates: [],
    });
    let proposals = 0;
    const triage = async (
      eventId: string,
      taskTitle: string,
      extractCommitments: NonNullable<Parameters<typeof runTriage>[0]['extractCommitments']>,
    ) => {
      const runner = new ScriptedRunner([[textMessage(JSON.stringify(modelOutput(taskTitle)))]]);
      const result = await runTriage(
        {
          db,
          config,
          agent: {
            runner,
            recorder: new MemoryRunRecorder(),
            ledger: new LedgerWriter(db),
            config: agentConfig,
            readSpendUsd: () => Promise.resolve(0),
          },
          createProposal: () => {
            proposals += 1;
            return Promise.resolve({
              proposalId: `sow-${proposals}`,
              decision: 'propose',
              status: 'pending',
            });
          },
          ontology: new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID }),
          principal: { name: 'Dom Selvon', email: 'dom@valliance.ai', notionUserId: 'notion-dom' },
          extractCommitments,
          debrief: { slack: null },
        },
        { watcher: 'jamie', correlationId: meetingCorrelationId, observationEventIds: [eventId] },
      );
      return { result };
    };

    const first = await triage(await observeMeeting({}), 'Read through the SOW', (source) => {
      expect(source.alreadyRecorded).toEqual([]);
      return Promise.resolve([
        commitment('Read through the SOW', 'I will read through the SOW by Friday'),
      ]);
    });
    expect(first.result.transcript).toBe('first');
    expect(first.result.commitments.map((c) => c.description)).toEqual(['Read through the SOW']);
    expect(first.result.taskProposals).toHaveLength(1);
    expect(first.result.debrief).not.toBeNull();

    // Jamie's summary lands after the transcript: a new hash, the same transcript.
    const repeat = await triage(
      await observeMeeting({ summaryShort: 'SOW review' }),
      'Read through the SOW that Brian sent back for review',
      () => Promise.reject(new Error('a transcript already read is not extracted again')),
    );
    expect(repeat.result.transcript).toBe('repeat');
    expect(repeat.result.commitments).toEqual([]);
    expect(repeat.result.taskProposals).toEqual([]);
    expect(repeat.result.debrief).toBeNull();
    expect(proposals).toBe(1);

    const changed = await triage(
      await observeMeeting({
        transcript: `${transcript} Brian: I will send the resourcing plan.`,
        summaryShort: 'SOW review',
      }),
      'Read through the SOW',
      (source) => {
        expect(source.alreadyRecorded).toEqual(['Read through the SOW']);
        return Promise.resolve([
          {
            ...commitment('Send the resourcing plan', 'I will send the resourcing plan'),
            direction: 'inbound' as const,
          },
        ]);
      },
    );
    expect(changed.result.transcript).toBe('changed');
    expect(changed.result.commitments.map((c) => c.description)).toEqual([
      'Send the resourcing plan',
    ]);
    expect(changed.result.debrief).toBeNull();
  });

  it('gives a retried run what the crashed run recorded and does not debrief the meeting twice', async () => {
    const meetingCorrelationId = stableUlid('jamie:mt-21');
    const record = {
      kind: 'meeting',
      id: 'mt-21',
      title: 'Anita / Dom',
      startTime: '2026-09-24T14:00:00.000Z',
      endTime: '2026-09-24T14:30:00.000Z',
      participants: [
        { name: 'Dom Selvon', email: 'dom@valliance.ai' },
        { name: 'Anita Shah', email: 'anita@valliance.ai' },
      ],
      attendees: [],
      transcript: 'Anita: Can finance support it? Dom: I will talk to you about the contractor.',
      transcriptReady: true,
      domAttended: true,
    };
    const hash = hashRecord(record);
    const observed = await new LedgerWriter(db).append({
      ts: '2026-09-24T14:30:00.000Z',
      actor: 'agent:watcher-jamie@0.1.0',
      kind: 'observed',
      sourceSystem: 'jamie',
      sourceRecordId: 'mt-21',
      sourceRecordHash: hash,
      idempotencyKey: idempotencyKey('jamie', 'mt-21', hash),
      correlationId: meetingCorrelationId,
      payload: { ...record, labels: ['Meeting', 'TranscriptReady'], watcher: 'jamie' },
    });
    const modelOutput = {
      importance: 0.4,
      urgency: 0.2,
      summary: 'Dom will talk to Anita.',
      entities: [],
      commitments: [],
      taskCandidates: [],
      proposalsSubmitted: 0,
      alertCandidates: [],
    };
    const commitment = (description: string) => ({
      direction: 'outbound' as const,
      description,
      counterpartyName: 'Anita Shah',
      counterpartyEmail: 'anita@valliance.ai',
      dueAt: null,
      dueConfidence: 0,
      evidenceQuote: 'I will talk to you about the contractor',
      recordId: 'mt-21',
    });
    const slackPosts: string[] = [];
    const triage = (
      extractCommitments: NonNullable<Parameters<typeof runTriage>[0]['extractCommitments']>,
      post: () => Promise<{ channel: string; ts: string }>,
    ) =>
      runTriage(
        {
          db,
          config,
          agent: {
            runner: new ScriptedRunner([[textMessage(JSON.stringify(modelOutput))]]),
            recorder: new MemoryRunRecorder(),
            ledger: new LedgerWriter(db),
            config: agentConfig,
            readSpendUsd: () => Promise.resolve(0),
          },
          createProposal: () => Promise.reject(new Error('no proposals in this test')),
          ontology: new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID }),
          principal: { name: 'Dom Selvon', email: 'dom@valliance.ai', notionUserId: 'notion-dom' },
          extractCommitments,
          debrief: {
            slack: {
              post: (message) => {
                slackPosts.push(message.text);
                return post();
              },
            },
          },
        },
        {
          watcher: 'jamie',
          correlationId: meetingCorrelationId,
          observationEventIds: [observed.id],
        },
      );

    // The first run records its commitment, then Slack fails and the job throws.
    await expect(
      triage(
        () => Promise.resolve([commitment('Talk to Anita about the contractor arrangement')]),
        () => Promise.reject(new Error('Slack is down')),
      ),
    ).rejects.toThrow('Slack is down');

    const retried = await triage(
      (source) => {
        expect(source.alreadyRecorded).toEqual(['Talk to Anita about the contractor arrangement']);
        return Promise.resolve([]);
      },
      () => Promise.resolve({ channel: 'C1', ts: '1.2' }),
    );
    expect(retried.transcript).toBe('first');
    expect(retried.commitments).toEqual([]);
    expect(retried.debrief).toBeNull();
    expect(slackPosts).toHaveLength(1);
  });

  it('refuses a job whose observations do not exist', async () => {
    const runner = new ScriptedRunner([]);
    await expect(
      runTriage(
        {
          db,
          config,
          agent: {
            runner,
            recorder: new MemoryRunRecorder(),
            ledger: new LedgerWriter(db),
            config: agentConfig,
            readSpendUsd: () => Promise.resolve(0),
          },
          createProposal: () => Promise.reject(new Error('unused')),
        },
        {
          watcher: 'graph-mail',
          correlationId: stableUlid('graph:none'),
          observationEventIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        },
      ),
    ).rejects.toThrow(/names no observed events/);
  });
});
