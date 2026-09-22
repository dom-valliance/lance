import {
  createProposalTool,
  readTools,
  runAgent,
  type AgentDeps,
  type CreateProposalHandler,
  type ReadToolDeps,
} from '@lance/agents';
import { BANNED_PHRASES, type ModelConfig } from '@lance/shared';
import { PlannerOutputSchema, type MorningBrief, type PlannerOutput } from './schema.js';

export const PLANNER_VERSION = '0.1.0';
export const PLANNER_ACTOR = `agent:planner@${PLANNER_VERSION}`;

/** Stable across runs so the prompt cache hits (spec 13). */
export function plannerSystemPrompt(displayName: string, minFreeBlockHours: number): string {
  return [
    `You are ${displayName}'s planner. ${displayName} is a personal operating agent for Dom Selvon, a director at Valliance, an AI consultancy. Each weekday morning you read the assembled facts for the day and add judgement: two objectives per meeting, a ranking of the tasks with one reason each, and calendar holds when the day leaves too little free time.`,
    '',
    'Rules.',
    '1. You add judgement, never facts. Every attendee, interaction, commitment, task and alert you may mention is already in the prompt with its provenance. Do not invent people, dates, numbers or outcomes.',
    '2. objectives: exactly two per meeting, each one sentence, specific to what the facts show is open with those people (a commitment to close, a question to settle, a decision to get). For a meeting with no history, the two objectives are about what to learn and what to agree.',
    '3. tasks: rank up to five of the listed tasks, rank 1 first, with a one-line reason each grounded in the facts (a meeting today, an overdue date, a client waiting). Only ids from the prompt.',
    `4. holds: when the day shape says free time is short (longest free block under ${String(minFreeBlockHours)} hours), call the create_proposal tool once per hold with action class create_calendar_hold, target system graph, a payload of subject, start, end (local ISO date-times without offset) and timeZone, a preview, a rationale naming the gap, and the calendar observation's provenance from the prompt. Never hold time over an existing meeting. Report how many you proposed in holdsProposed.`,
    "5. Write in Dom's voice: British English, direct, no em dashes, none of these phrases: " +
      BANNED_PHRASES.join(', ') +
      '.',
    '6. Reply with only the JSON object once you have finished any tool calls.',
  ].join('\n');
}

function line(items: readonly string[]): string {
  return items.length === 0 ? '  none' : items.map((item) => `  - ${item}`).join('\n');
}

export function plannerUserPrompt(brief: MorningBrief): string {
  const meetings = brief.meetings.map((meeting) =>
    [
      `Meeting ${meeting.eventId}: ${meeting.subject}, ${meeting.start} to ${meeting.end ?? 'unknown'}, ${meeting.isExternal ? 'external' : 'internal'}`,
      `  attendees: ${meeting.attendees.map((a) => `${a.name}${a.organisation === null ? '' : ` (${a.organisation})`}${a.known ? '' : ' [unknown]'}`).join('; ') || 'none'}`,
      `  recent: ${meeting.lastInteractions.map((i) => `${i.kind} ${i.at.slice(0, 10)}: ${i.summary}`).join('; ') || 'none'}`,
      `  open commitments: ${meeting.openCommitments.map((c) => `${c.direction} ${c.description}${c.daysOverdue === null ? '' : ` (${String(c.daysOverdue)} days overdue)`}`).join('; ') || 'none'}`,
      `  documents: ${meeting.documents.map((d) => d.title).join('; ') || 'none'}`,
      `  provenance: ${meeting.provenance.map((p) => `${p.system}:${p.recordId}:${p.hash}:${p.observedAt}`).join(' ')}`,
    ].join('\n'),
  );
  return [
    `Date: ${brief.date}`,
    `Day shape: first ${brief.dayShape.firstMeeting ?? 'none'}, last ${brief.dayShape.lastMeeting ?? 'none'}, ${String(brief.dayShape.meetingHours)} meeting hours, longest free block ${String(brief.dayShape.longestFreeBlockHours)} hours, free time short: ${String(brief.dayShape.freeTimeShort)}`,
    '',
    'Meetings:',
    meetings.length === 0 ? '  none' : meetings.join('\n'),
    '',
    'Tasks due today or overdue:',
    line(
      brief.tasks.map(
        (t) =>
          `${t.id} | ${t.source} | ${t.title} | due ${t.due ?? 'none'}${t.overdue ? ' (overdue)' : ''}`,
      ),
    ),
    '',
    'Waiting for (inbound commitments past their chase date):',
    line(brief.waitingFor.map((c) => `${c.id} | ${c.counterparty} | ${c.description}`)),
    '',
    'Overnight alerts:',
    line(brief.overnight.alerts.map((a) => `${a.severity} ${a.title}`)),
    `Pending proposals: ${String(brief.overnight.pendingProposals.count)}`,
    '',
    'Return the JSON object.',
  ].join('\n');
}

export interface PlannerDeps {
  agent: AgentDeps;
  model: ModelConfig;
  displayName: string;
  minFreeBlockHours: number;
  reads: ReadToolDeps;
  createProposal: CreateProposalHandler;
}

/** The Planner's pass over an assembled brief (spec 7.3): objectives, ranking, holds. */
export async function planMorningBrief(
  deps: PlannerDeps,
  brief: MorningBrief,
  correlationId: string,
): Promise<{ output: PlannerOutput; runId: string }> {
  const result = await runAgent(
    deps.agent,
    {
      name: 'planner',
      version: PLANNER_VERSION,
      model: deps.model,
      system: plannerSystemPrompt(deps.displayName, deps.minFreeBlockHours),
      tools: [...readTools(deps.reads), createProposalTool(deps.createProposal)],
      outputSchema: PlannerOutputSchema,
      maxIterations: 8,
    },
    { correlationId, prompt: plannerUserPrompt(brief) },
  );
  return { output: result.output, runId: result.runId };
}

/** Folds the Planner's judgement into the brief; unknown ids are ignored, never added. */
export function applyPlan(brief: MorningBrief, plan: PlannerOutput): MorningBrief {
  const objectives = new Map(plan.meetings.map((m) => [m.eventId, m.objectives]));
  const ranked = new Map(plan.tasks.map((t) => [t.id, t]));
  const tasks = [...brief.tasks]
    .map((task) => ({ ...task, reason: ranked.get(task.id)?.reason ?? null }))
    .sort((a, b) => (ranked.get(a.id)?.rank ?? 99) - (ranked.get(b.id)?.rank ?? 99));
  return {
    ...brief,
    meetings: brief.meetings.map((meeting) => ({
      ...meeting,
      objectives: objectives.get(meeting.eventId) ?? [],
    })),
    tasks,
  };
}
