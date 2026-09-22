import { runAgent, type AgentDeps, type ProposalDraft } from '@lance/agents';
import type { SlackSurface } from '@lance/connectors';
import { briefs, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso, type Config, type ProvenanceRef } from '@lance/shared';
import type { RecordedCommitment } from '../commitments/record.js';
import type { ProposalContext, createProposalHandler } from '../executor/createProposal.js';
import type { QuotedPoint } from '../triage/schema.js';
import { followUpSystemPrompt, followUpUserPrompt } from './prompt.js';
import { FollowUpDraftSchema } from './schema.js';

export const DEBRIEF_VERSION = '0.1.0';
export const DEBRIEF_ACTOR = `agent:debrief@${DEBRIEF_VERSION}`;

export interface DebriefPerson {
  name: string;
  email: string | null;
}

export interface DebriefMeeting {
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
  participants: readonly DebriefPerson[];
  attendees: readonly DebriefPerson[];
  summaryShort: string | null;
  url: string | null;
}

export interface DebriefDeps {
  db: Db;
  config: Pick<Config, 'agentDisplayName' | 'timeZone' | 'models'>;
  dom: { name: string; email: string };
  agent: AgentDeps;
  slack: Pick<SlackSurface, 'post'> | null;
  createProposal: ReturnType<typeof createProposalHandler>;
  now?: () => string;
}

export interface DebriefInput {
  correlationId: string;
  meeting: DebriefMeeting;
  provenance: ProvenanceRef[];
  summary: string;
  decisions: readonly QuotedPoint[];
  openQuestions: readonly QuotedPoint[];
  taskProposalIds: readonly string[];
  commitments: readonly RecordedCommitment[];
  context: ProposalContext;
}

export interface DebriefResult {
  briefId: string;
  followUpProposalId: string | null;
  slackTs: string | null;
}

function domainOf(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

/** Attendees and participants outside Dom's own domain, de-duplicated by email. */
export function externalPeople(meeting: DebriefMeeting, domEmail: string): DebriefPerson[] {
  const home = domainOf(domEmail);
  const seen = new Set<string>();
  const out: DebriefPerson[] = [];
  for (const person of [...meeting.attendees, ...meeting.participants]) {
    const domain = domainOf(person.email);
    if (person.email === null || domain === null || domain === home) continue;
    const key = person.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: person.name, email: key });
  }
  return out;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function renderDebriefMarkdown(input: DebriefInput, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(input.meeting.startTime));
  const people = [...input.meeting.attendees, ...input.meeting.participants]
    .map((person) => person.name)
    .filter((name, index, all) => all.indexOf(name) === index);
  const list = (items: readonly string[]): string =>
    items.length === 0 ? '- none' : items.map((item) => `- ${item}`).join('\n');
  return [
    `# Debrief: ${input.meeting.title}`,
    `${date}. ${people.join(', ')}.`,
    '',
    '## Summary',
    input.summary,
    '',
    '## Decisions',
    list(input.decisions.map((point) => point.text)),
    '',
    '## Actions proposed',
    list(input.taskProposalIds.map((id) => `Proposal ${id}`)),
    '',
    '## Commitments',
    list(
      input.commitments.map(
        (commitment) =>
          `${commitment.direction === 'outbound' ? 'Dom owes' : 'Owed to Dom'}: ${commitment.description}`,
      ),
    ),
    '',
    '## Open questions',
    list(input.openQuestions.map((point) => point.text)),
  ].join('\n');
}

/**
 * The debrief (spec 10.4) as deterministic assembly over what triage and
 * the commitment recorder produced: a brief row, a Slack message, and one
 * follow-up email draft to the external attendees as a `draft_email`
 * proposal. Every proposal in it goes through policy like any other; in
 * v1 the seed rules make them all propose.
 */
export async function runDebrief(deps: DebriefDeps, input: DebriefInput): Promise<DebriefResult> {
  const now = deps.now ?? nowIso;
  const markdown = renderDebriefMarkdown(input, deps.config.timeZone);
  const external = externalPeople(input.meeting, deps.dom.email);

  let followUpProposalId: string | null = null;
  if (external.length > 0) {
    const draft = await runAgent(
      deps.agent,
      {
        name: 'debrief-draft',
        version: DEBRIEF_VERSION,
        model: deps.config.models.triage,
        system: followUpSystemPrompt(deps.config.agentDisplayName),
        tools: [],
        outputSchema: FollowUpDraftSchema,
        maxIterations: 1,
      },
      {
        correlationId: input.correlationId,
        prompt: followUpUserPrompt({
          title: input.meeting.title,
          date: input.meeting.startTime.slice(0, 10),
          externalNames: external.map((person) => firstName(person.name)),
          summary: input.meeting.summaryShort ?? input.summary,
          decisions: input.decisions.map((point) => point.text),
          domOwes: input.commitments
            .filter((commitment) => commitment.direction === 'outbound')
            .map((commitment) => commitment.description),
          theyOwe: input.commitments
            .filter((commitment) => commitment.direction === 'inbound')
            .map((commitment) => commitment.description),
          openQuestions: input.openQuestions.map((point) => point.text),
        }),
      },
    );
    const proposal: ProposalDraft = {
      actionClass: 'draft_email',
      counterpartyClass: 'unknown',
      targetSystem: 'graph',
      targetRecordId: null,
      payload: {
        subject: draft.output.subject,
        bodyText: draft.output.bodyText,
        to: external.map((person) => person.email),
        meetingId: input.meeting.id,
      },
      preview: `Draft follow-up to ${external.map((person) => person.name).join(', ')}: ${draft.output.subject}`,
      rationale: `Follow-up after "${input.meeting.title}"; the draft only states what the transcript supports.`,
      provenance: input.provenance,
      confidence: 0.7,
    };
    const outcome = await deps.createProposal(proposal, { ...input.context, actor: DEBRIEF_ACTOR });
    followUpProposalId = outcome.proposalId;
  }

  const briefId = newUlid();
  await deps.db.insert(briefs).values({
    id: briefId,
    kind: 'debrief',
    correlationId: input.correlationId,
    content: {
      meeting: input.meeting,
      summary: input.summary,
      decisions: input.decisions,
      openQuestions: input.openQuestions,
      taskProposalIds: input.taskProposalIds,
      commitments: input.commitments,
      followUpProposalId,
      provenance: input.provenance,
    },
    markdown,
    generatedAt: new Date(now()),
  });

  let slackTs: string | null = null;
  if (deps.slack !== null) {
    const lines = [
      `*Debrief: ${input.meeting.title}*`,
      input.summary,
      input.decisions.length === 0
        ? null
        : `Decisions: ${input.decisions.map((point) => point.text).join('; ')}`,
      `Actions proposed: ${String(input.taskProposalIds.length)}. Commitments recorded: ${String(input.commitments.length)}.`,
      followUpProposalId === null ? null : 'A follow-up email draft is waiting for approval.',
      input.meeting.url === null ? null : `<${input.meeting.url}|Open in Jamie>`,
    ].filter((line): line is string => line !== null);
    const posted = await deps.slack.post(
      { text: lines.join('\n') },
      { correlationId: input.correlationId },
    );
    slackTs = posted.ts;
  }

  await new LedgerWriter(deps.db).append({
    ts: now(),
    actor: DEBRIEF_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId: input.correlationId,
    payload: {
      kind: 'debrief',
      briefId,
      meetingId: input.meeting.id,
      followUpProposalId,
      slackTs,
      provenance: input.provenance,
    },
  });

  return { briefId, followUpProposalId, slackTs };
}
