import {
  createProposalTool,
  readTools,
  runAgent,
  type AgentDeps,
  type CommitmentCandidate,
  type CommitmentExtractor,
  type ProposalDraft,
} from '@lance/agents';
import { observations, proposals, type Db } from '@lance/db';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { nowIso, type Config, type ProvenanceRef } from '@lance/shared';
import { and, eq } from 'drizzle-orm';
import type { OntologyRepository } from '@lance/ontology';
import { raiseAlert } from '../alerts/raise.js';
import { recordCommitments, type RecordedCommitment } from '../commitments/record.js';
import { runDebrief, type DebriefDeps, type DebriefResult } from '../debrief/run.js';
import type { ProposalContext, createProposalHandler } from '../executor/createProposal.js';
import { icalUidOfGraphEvent } from '../watchers/graph/icalUid.js';
import type { TriageJob } from '../watchers/runner.js';
import { watcherStartedAt } from '../watchers/runner.js';
import { triageSystemPrompt, triageUserPrompt } from './prompt.js';
import { TriageOutputSchema, type TaskCandidate, type TriageOutput } from './schema.js';

export const TRIAGE_VERSION = '0.1.0';
export const TRIAGE_ACTOR = `agent:triage@${TRIAGE_VERSION}`;

export interface TriageDeps {
  db: Db;
  config: Pick<Config, 'agentDisplayName' | 'models' | 'notion' | 'watchers' | 'timeZone'>;
  agent: Omit<AgentDeps, 'config'> & { config: AgentDeps['config'] };
  createProposal: ReturnType<typeof createProposalHandler>;
  /** Phase 2 collaborators. Absent (tests, a process without them) means the step is skipped. */
  ontology?: OntologyRepository | null;
  extractCommitments?: CommitmentExtractor | null;
  dom?: { name: string; email: string; notionUserId?: string | null } | null;
  debrief?: Pick<DebriefDeps, 'slack'> | null;
  now?: () => string;
}

export interface TriageResult {
  correlationId: string;
  output: TriageOutput;
  taskProposals: string[];
  alerts: string[];
  commitments: RecordedCommitment[];
  debrief: DebriefResult | null;
  runId: string;
}

/** The parts of a `jamie` meeting observation the Phase 2 steps read. */
interface MeetingObservation {
  eventId: string;
  recordId: string;
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
  participants: { name: string; email: string | null }[];
  attendees: { name: string; email: string | null }[];
  graphEventId: string | null;
  tags: string[];
  summaryShort: string | null;
  transcript: string | null;
  transcriptReady: boolean;
  domAttended: boolean;
  url: string | null;
}

function people(value: unknown): { name: string; email: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { name, email } = item as { name?: unknown; email?: unknown };
    if (typeof name !== 'string' || name === '') return [];
    return [{ name, email: typeof email === 'string' && email !== '' ? email : null }];
  });
}

function meetingObservationOf(event: {
  id: string;
  sourceRecordId: string | null;
  payload: unknown;
}): MeetingObservation | null {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload === null || payload['watcher'] !== 'jamie' || payload['kind'] !== 'meeting')
    return null;
  if (typeof payload['id'] !== 'string' || typeof payload['startTime'] !== 'string') return null;
  const str = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  };
  return {
    eventId: event.id,
    recordId: event.sourceRecordId ?? payload['id'],
    id: payload['id'],
    title: str('title') ?? '(untitled)',
    startTime: payload['startTime'],
    endTime: str('endTime'),
    participants: people(payload['participants']),
    attendees: people(payload['attendees']),
    graphEventId: str('graphEventId'),
    tags: Array.isArray(payload['tags'])
      ? payload['tags'].filter((tag): tag is string => typeof tag === 'string')
      : [],
    summaryShort: str('summaryShort'),
    transcript: str('transcript'),
    transcriptReady: payload['transcriptReady'] === true,
    domAttended: payload['domAttended'] === true,
    url: str('url'),
  };
}

/** Working days from the watcher's first run; the first five are dry run (spec 6.3). */
export function workingDaysBetween(start: Date, end: Date): number {
  let days = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor < last) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
  }
  return days;
}

function provenanceFor(
  events: Array<{
    sourceSystem: string | null;
    sourceRecordId: string | null;
    sourceRecordHash: string | null;
    ts: Date;
    payload: unknown;
  }>,
  recordId: string,
): ProvenanceRef[] {
  const refs: ProvenanceRef[] = [];
  for (const event of events) {
    if (
      event.sourceRecordId !== recordId ||
      event.sourceSystem === null ||
      event.sourceRecordHash === null
    )
      continue;
    const url = (event.payload as Record<string, unknown> | null)?.['url'];
    refs.push({
      system: event.sourceSystem as ProvenanceRef['system'],
      recordId,
      hash: event.sourceRecordHash,
      observedAt: event.ts.toISOString(),
      ...(typeof url === 'string' ? { url } : {}),
    });
  }
  return refs;
}

function taskTitleOf(draft: ProposalDraft): string {
  const input = draft.payload['input'];
  const title =
    typeof input === 'object' && input !== null ? (input as { title?: unknown }).title : undefined;
  return typeof title === 'string' ? title : '';
}

/** Title to proposal id for the create_task proposals already on a correlation id. */
async function existingTaskProposals(db: Db, correlationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: proposals.id, payload: proposals.payload })
    .from(proposals)
    .where(
      and(eq(proposals.correlationId, correlationId), eq(proposals.actionClass, 'create_task')),
    );
  const byTitle = new Map<string, string>();
  for (const row of rows) {
    const input = (row.payload as { input?: { title?: unknown } } | null)?.input;
    if (typeof input?.title === 'string') byTitle.set(input.title, row.id);
  }
  return byTitle;
}

/** Deterministic conversion of a task candidate into a Notion create_task draft (ADR 0009). */
export function taskDraft(
  candidate: TaskCandidate,
  provenance: ProvenanceRef[],
  notion: Config['notion'],
): ProposalDraft {
  const delegate =
    candidate.assigneeName !== null && candidate.assigneeName.trim().length > 0
      ? candidate.assigneeName.trim()
      : null;
  const title = delegate === null ? candidate.title : `${candidate.title} (${delegate})`;
  const payload: Record<string, unknown> = {
    dataSourceId: notion.tasksDataSourceId,
    // The Notion connector's createTask input shape (camelCase keys mapped to
    // property names by the connector); the critic checks the same keys.
    input: {
      title,
      assigneeIds: [notion.domUserId],
      ...(candidate.dueDate === null ? {} : { due: candidate.dueDate }),
      ...(candidate.priority === null ? {} : { priority: candidate.priority }),
      ...(candidate.description === null ? {} : { description: candidate.description }),
      notes: `Source: ${provenance[0]?.system ?? 'unknown'} ${provenance[0]?.recordId ?? ''}. Evidence: "${candidate.evidenceQuote}"`,
    },
    ...(delegate === null ? {} : { delegateName: delegate }),
  };
  return {
    actionClass: 'create_task',
    counterpartyClass: delegate === null ? 'self' : 'internal',
    targetSystem: 'notion',
    targetRecordId: null,
    payload,
    preview: `Create Notion task: ${title}${candidate.dueDate === null ? '' : ` (due ${candidate.dueDate})`}`,
    rationale: `From "${candidate.evidenceQuote}".`,
    provenance,
    confidence: 0.8,
  };
}

/**
 * Triage for one correlation id (spec 7.2): the model reads the batch with
 * read tools and submits action proposals through create_proposal; task
 * candidates and alert candidates are turned into proposals and alerts by
 * this deterministic code afterwards.
 */
export async function runTriage(deps: TriageDeps, job: TriageJob): Promise<TriageResult> {
  const now = deps.now ?? nowIso;
  const reader = new LedgerReader(deps.db);
  const events = (await reader.byCorrelation(job.correlationId)).filter(
    (event) => event.kind === 'observed' && job.observationEventIds.includes(event.id),
  );
  if (events.length === 0) {
    throw new Error(`Triage job for ${job.correlationId} names no observed events that exist.`);
  }

  const startedAt = await watcherStartedAt(deps.db, job.watcher);
  const watcherDryRun =
    startedAt !== null &&
    workingDaysBetween(new Date(startedAt), new Date(now())) <
      deps.config.watchers.dryRunDaysForNewWatcher;
  const labels = [
    ...new Set(
      events.flatMap((event) => {
        const value = (event.payload as Record<string, unknown> | null)?.['labels'];
        return Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
      }),
    ),
  ];
  const context: ProposalContext = {
    correlationId: job.correlationId,
    actor: TRIAGE_ACTOR,
    labels,
    watcherDryRun,
  };

  const tools = [
    ...readTools({
      searchLedger: async (query) =>
        (
          await reader.query({
            ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
            limit: query.limit,
          })
        ).map((event) => ({
          id: event.id,
          ts: event.ts.toISOString(),
          kind: event.kind,
          actor: event.actor,
          sourceSystem: event.sourceSystem,
          sourceRecordId: event.sourceRecordId,
          correlationId: event.correlationId,
          summary:
            ((event.payload as Record<string, unknown> | null)?.['summary'] as
              string | undefined) ?? null,
        })),
      getSourceRecord: async (system, recordId) => {
        const rows = await deps.db
          .select({ payload: observations.payload })
          .from(observations)
          .where(
            and(eq(observations.sourceSystem, system), eq(observations.sourceRecordId, recordId)),
          )
          .limit(1);
        return (rows[0]?.payload as Record<string, unknown> | undefined) ?? null;
      },
      lookupEntity: () => Promise.resolve([]),
    }),
    createProposalTool((draft) => deps.createProposal(draft, context)),
  ];

  const result = await runAgent(
    deps.agent,
    {
      name: 'triage',
      version: TRIAGE_VERSION,
      model: deps.config.models.triage,
      system: triageSystemPrompt(deps.config.agentDisplayName),
      tools,
      outputSchema: TriageOutputSchema,
      maxIterations: 8,
    },
    { correlationId: job.correlationId, prompt: triageUserPrompt(events) },
  );
  const output = result.output;

  // A retried job (pg-boss redelivers after a crash between the proposals
  // and the resolved event) must not propose the same task twice, so a
  // candidate whose title already has a create_task proposal on this
  // correlation id is reported as that proposal rather than created again.
  const existing = await existingTaskProposals(deps.db, job.correlationId);
  const taskProposals: string[] = [];
  for (const candidate of output.taskCandidates) {
    const provenance = provenanceFor(events, candidate.recordId);
    if (provenance.length === 0) continue;
    const draft = taskDraft(candidate, provenance, deps.config.notion);
    const already = existing.get(taskTitleOf(draft));
    if (already !== undefined) {
      taskProposals.push(already);
      continue;
    }
    const outcome = await deps.createProposal(draft, context);
    taskProposals.push(outcome.proposalId);
  }

  const alerts: string[] = [];
  for (const candidate of output.alertCandidates) {
    if (candidate.kind !== 'risk_language_in_client_mail') continue;
    const provenance = provenanceFor(events, candidate.recordId);
    // Non-negotiable 5: an alert with nothing to point at is not raised.
    if (provenance.length === 0) continue;
    const raised = await raiseAlert(deps.db, {
      kind: 'risk_language_in_client_mail',
      severity: 'P0',
      dedupeKey: `risk:${job.correlationId}`,
      title: candidate.title,
      body: `"${candidate.evidenceQuote}"`,
      provenance,
      actor: TRIAGE_ACTOR,
      correlationId: job.correlationId,
    });
    alerts.push(raised.alertId);
  }

  // Phase 2: the meeting in the graph, the commitments it or the mail
  // contains, and the debrief when a transcript for a meeting Dom attended
  // has arrived (spec 5.2, 10.4). Each step is deterministic code over
  // what the models returned.
  const meetings = events
    .map((event) => meetingObservationOf(event))
    .filter((meeting): meeting is MeetingObservation => meeting !== null);
  const newest = meetings.reduce<MeetingObservation | null>(
    (best, meeting) =>
      best === null || (meeting.transcriptReady && !best.transcriptReady) ? meeting : best,
    null,
  );

  let meetingNodeId: string | null = null;
  const directory = newest === null ? [] : [...newest.attendees, ...newest.participants];
  if (deps.ontology && newest !== null) {
    const mutation = { correlationId: job.correlationId, actor: TRIAGE_ACTOR };
    const sourceRef = {
      system: 'jamie' as const,
      id: newest.id,
      observedAt: now(),
      ...(newest.url === null ? {} : { url: newest.url }),
    };
    // Jamie names the calendar event by its Graph id, which is specific to
    // one mailbox; the principal's own calendar observation of that event
    // gives the iCalUId every attendee shares (ADR 0017). With no match the
    // meeting keys on its Jamie id alone.
    const icalUid =
      newest.graphEventId === null ? null : await icalUidOfGraphEvent(deps.db, newest.graphEventId);
    const node = await deps.ontology.upsertMeeting(
      {
        title: newest.title,
        start: newest.startTime,
        end: newest.endTime,
        icalUid,
        jamieId: newest.id,
        graphEventId: newest.graphEventId,
        tags: newest.tags,
        sourceRef,
      },
      mutation,
    );
    meetingNodeId = node.id;
    for (const person of directory) {
      const resolved = await deps.ontology.resolvePerson(
        {
          displayName: person.name,
          emails: person.email === null ? [] : [person.email],
          sourceRef,
        },
        mutation,
      );
      await deps.ontology.link(resolved.id, 'ATTENDED', node.id, {}, mutation);
    }
  }

  let commitmentCandidates: CommitmentCandidate[] = [...output.commitments];
  if (
    deps.extractCommitments &&
    deps.dom &&
    newest !== null &&
    newest.transcriptReady &&
    newest.transcript !== null
  ) {
    const extracted = await deps.extractCommitments(
      {
        id: newest.recordId,
        kind: 'transcript',
        dom: { name: deps.dom.name, email: deps.dom.email },
        participants: directory,
        occurredAt: newest.startTime,
        text: newest.transcript,
      },
      job.correlationId,
    );
    // The extractor read the whole transcript with the commitment rules in
    // front of it; the triage model saw the same text while doing five other
    // jobs. Keeping both recorded the same promise twice under two wordings,
    // so for a record the extractor covered its list is the list.
    commitmentCandidates = [
      ...commitmentCandidates.filter((candidate) => candidate.recordId !== newest.recordId),
      ...extracted,
    ];
  }
  commitmentCandidates = commitmentCandidates.filter(
    (candidate) => provenanceFor(events, candidate.recordId).length > 0,
  );

  // Each commitment is recorded with the provenance of the record it was
  // quoted from (non-negotiable 5), so candidates are grouped by record: a
  // correlation id can carry a meeting and its action items together.
  const recordedCommitments: RecordedCommitment[] = [];
  if (deps.ontology && deps.dom) {
    const byRecord = new Map<string, CommitmentCandidate[]>();
    for (const candidate of commitmentCandidates) {
      const group = byRecord.get(candidate.recordId) ?? [];
      group.push(candidate);
      byRecord.set(candidate.recordId, group);
    }
    for (const [recordId, group] of byRecord) {
      const result = await recordCommitments(
        { db: deps.db, ontology: deps.ontology, dom: deps.dom, now },
        group,
        {
          correlationId: job.correlationId,
          actor: TRIAGE_ACTOR,
          provenance: provenanceFor(events, recordId),
          derivedFromNodeId: meetingNodeId,
          directory,
        },
      );
      recordedCommitments.push(...result.recorded);
    }
  }

  let debrief: DebriefResult | null = null;
  if (deps.debrief && deps.dom && newest !== null && newest.transcriptReady && newest.domAttended) {
    debrief = await runDebrief(
      {
        db: deps.db,
        config: deps.config,
        dom: deps.dom,
        agent: deps.agent,
        slack: deps.debrief.slack,
        createProposal: deps.createProposal,
        now,
      },
      {
        correlationId: job.correlationId,
        meeting: {
          id: newest.id,
          title: newest.title,
          startTime: newest.startTime,
          endTime: newest.endTime,
          participants: newest.participants,
          attendees: newest.attendees,
          summaryShort: newest.summaryShort,
          url: newest.url,
        },
        provenance: provenanceFor(events, newest.recordId),
        summary: output.summary,
        decisions: output.decisions,
        openQuestions: output.openQuestions,
        taskProposalIds: taskProposals,
        commitments: recordedCommitments,
        context,
      },
    );
  }

  await new LedgerWriter(deps.db).append({
    ts: now(),
    actor: TRIAGE_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId: job.correlationId,
    payload: {
      kind: 'triage',
      runId: result.runId,
      importance: output.importance,
      urgency: output.urgency,
      summary: output.summary,
      entities: output.entities,
      commitments: output.commitments,
      taskCandidates: output.taskCandidates,
      proposalsSubmitted: output.proposalsSubmitted,
      taskProposals,
      alerts,
      recordedCommitmentIds: recordedCommitments.map((commitment) => commitment.id),
      debriefId: debrief?.briefId ?? null,
      observationEventIds: events.map((event) => event.id),
      watcherDryRun,
    },
  });

  return {
    correlationId: job.correlationId,
    output,
    taskProposals,
    alerts,
    commitments: recordedCommitments,
    debrief,
    runId: result.runId,
  };
}
