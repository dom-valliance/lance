import {
  createProposalTool,
  readTools,
  runAgent,
  type AgentDeps,
  type ProposalDraft,
} from '@lance/agents';
import { observations, proposals, type Db } from '@lance/db';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { nowIso, type Config, type ProvenanceRef } from '@lance/shared';
import { and, eq } from 'drizzle-orm';
import { raiseAlert } from '../alerts/raise.js';
import type { ProposalContext, createProposalHandler } from '../executor/createProposal.js';
import type { TriageJob } from '../watchers/runner.js';
import { watcherStartedAt } from '../watchers/runner.js';
import { triageSystemPrompt, triageUserPrompt } from './prompt.js';
import { TriageOutputSchema, type TaskCandidate, type TriageOutput } from './schema.js';

export const TRIAGE_VERSION = '0.1.0';
export const TRIAGE_ACTOR = `agent:triage@${TRIAGE_VERSION}`;

export interface TriageDeps {
  db: Db;
  config: Pick<Config, 'agentDisplayName' | 'models' | 'notion' | 'watchers'>;
  agent: Omit<AgentDeps, 'config'> & { config: AgentDeps['config'] };
  createProposal: ReturnType<typeof createProposalHandler>;
  now?: () => string;
}

export interface TriageResult {
  correlationId: string;
  output: TriageOutput;
  taskProposals: string[];
  alerts: string[];
  runId: string;
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
      observationEventIds: events.map((event) => event.id),
      watcherDryRun,
    },
  });

  return { correlationId: job.correlationId, output, taskProposals, alerts, runId: result.runId };
}
