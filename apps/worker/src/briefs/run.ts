import { BudgetExceededError, type AgentDeps, type ReadToolDeps } from '@lance/agents';
import type { SlackSurface } from '@lance/connectors';
import { briefs, proposals, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import type { OntologyRepository } from '@lance/ontology';
import {
  AfternoonBoardContentSchema,
  MorningBriefContentSchema,
  newUlid,
  nowIso,
  type Config,
  type MorningBriefContent,
} from '@lance/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { work } from '../scheduler/boss.js';
import type { createProposalHandler } from '../executor/createProposal.js';
import {
  PREP_LEAD_MINUTES,
  assembleAfternoonBoard,
  assembleMorningBrief,
  calendarEvents,
  type BriefDataDeps,
} from './data.js';
import { addDays, localDate, startOfLocalDay } from './local.js';
import { PLANNER_ACTOR, applyPlan, planMorningBrief } from './planner.js';
import {
  renderAfternoonBoardMarkdown,
  renderAfternoonBoardSlack,
  renderMorningBriefMarkdown,
  renderMorningBriefSlack,
} from './render.js';

export { PREP_LEAD_MINUTES };

/**
 * The briefs (spec 10): assembled by deterministic code, judged by the
 * Planner, validated against the shared content schemas, stored in
 * `briefs`, posted to Slack as a parent message with one thread reply per
 * section (spec 9.1), and recorded in the ledger. Briefs and boards do not
 * count against the push budget.
 */

export const BRIEFS_ACTOR = 'system:briefs';
export const QUEUE_MORNING = 'brief-morning';
export const QUEUE_BOARD = 'brief-afternoon';
export const QUEUE_PREP = 'brief-meeting-prep';

export interface BriefDeps {
  db: Db;
  config: Pick<Config, 'timeZone' | 'dom' | 'briefs' | 'cost' | 'models' | 'agentDisplayName'>;
  ontology: OntologyRepository;
  /** Null means no model: the brief is posted from the assembled facts alone. */
  agent: AgentDeps | null;
  reads: ReadToolDeps;
  slack: Pick<SlackSurface, 'post'> | null;
  createProposal: ReturnType<typeof createProposalHandler>;
  now?: () => string;
}

export interface BriefResult {
  briefId: string;
  correlationId: string;
  slackTs: string | null;
}

/** Slack delivery details stored beside the validated content. */
interface SlackDelivery {
  slackTs: string | null;
  slackThreads?: Record<string, string>;
}

type StoredMorningBrief = MorningBriefContent & SlackDelivery;

function dataDeps(deps: BriefDeps, now: () => string): BriefDataDeps {
  return { db: deps.db, ontology: deps.ontology, config: deps.config, now };
}

async function recordBrief(
  deps: BriefDeps,
  kind: 'morning_brief' | 'afternoon_board' | 'meeting_prep',
  correlationId: string,
  content: object,
  markdown: string,
  slackTs: string | null,
  now: () => string,
): Promise<string> {
  const briefId = newUlid();
  await deps.db.insert(briefs).values({
    id: briefId,
    kind,
    correlationId,
    content,
    markdown,
    generatedAt: new Date(now()),
  });
  await new LedgerWriter(deps.db).append({
    ts: now(),
    actor: BRIEFS_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId,
    payload: { kind: 'brief', briefKind: kind, briefId, slackTs },
  });
  return briefId;
}

export async function runMorningBrief(deps: BriefDeps): Promise<BriefResult> {
  const now = deps.now ?? nowIso;
  const correlationId = newUlid();
  const assembled = await assembleMorningBrief(dataDeps(deps, now));
  let brief = assembled.content;

  let plannerNote: string | null = null;
  if (deps.agent !== null) {
    const context = { correlationId, actor: PLANNER_ACTOR };
    let plan: Awaited<ReturnType<typeof planMorningBrief>> | null = null;
    try {
      plan = await planMorningBrief(
        {
          agent: deps.agent,
          model: deps.config.models.planner,
          displayName: deps.config.agentDisplayName,
          minFreeBlockHours: deps.config.briefs.minFreeBlockHours,
          reads: deps.reads,
          createProposal: (draft) => deps.createProposal(draft, context),
        },
        brief,
        assembled.freeTimeShort,
        correlationId,
      );
    } catch (error) {
      // Spec 13: at the ceiling the planner waits, the brief does not. The
      // facts go out on their own and say why the judgement is missing.
      if (!(error instanceof BudgetExceededError)) throw error;
      plannerNote = `The planner did not run: ${error.message}`;
    }
    if (plan !== null) brief = applyPlan(brief, plan.output);
    const holds = await deps.db
      .select({ id: proposals.id, preview: proposals.preview })
      .from(proposals)
      .where(
        and(
          eq(proposals.correlationId, correlationId),
          eq(proposals.actionClass, 'create_calendar_hold'),
        ),
      );
    brief = {
      ...brief,
      dayShape: {
        ...brief.dayShape,
        proposedHolds: holds.map((row) => ({ proposalId: row.id, title: row.preview })),
        note: holds.length === 0 ? brief.dayShape.note : null,
      },
    };
  }

  // The contract the api and the Today page read; a shape error fails the run rather than storing junk.
  const content = MorningBriefContentSchema.parse(
    plannerNote === null ? brief : { ...brief, headline: `${brief.headline} ${plannerNote}` },
  );

  // Stored before Slack sees it, so a failed post leaves the brief on the
  // Today page and a retry does not run the planner again.
  const briefId = await recordBrief(
    deps,
    'morning_brief',
    correlationId,
    { ...content, slackTs: null } satisfies StoredMorningBrief,
    renderMorningBriefMarkdown(content, deps.config.timeZone),
    null,
    now,
  );

  let delivery: SlackDelivery = { slackTs: null };
  if (deps.slack !== null) {
    const rendered = renderMorningBriefSlack(
      content,
      deps.config.timeZone,
      deps.config.agentDisplayName,
    );
    const parent = await deps.slack.post({ text: rendered.parent }, { correlationId });
    const threads: Record<string, string> = {};
    for (const section of rendered.sections) {
      const reply = await deps.slack.post(
        { text: section.text, threadTs: parent.ts },
        { correlationId },
      );
      if (section.key.startsWith('meeting:'))
        threads[section.key.slice('meeting:'.length)] = reply.ts;
    }
    delivery = { slackTs: parent.ts, slackThreads: threads };
    await deps.db
      .update(briefs)
      .set({ content: { ...content, ...delivery } satisfies StoredMorningBrief })
      .where(eq(briefs.id, briefId));
  }
  return { briefId, correlationId, slackTs: delivery.slackTs };
}

/** The most recent morning brief for today's local date, if any. */
async function todaysMorningBrief(
  deps: BriefDeps,
  now: () => string,
): Promise<typeof briefs.$inferSelect | null> {
  const dayStart = startOfLocalDay(new Date(now()), deps.config.timeZone);
  const rows = await deps.db
    .select()
    .from(briefs)
    .where(and(eq(briefs.kind, 'morning_brief'), gte(briefs.generatedAt, dayStart)))
    .orderBy(desc(briefs.generatedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Stored content that fails the schema is treated as absent; the prep falls back to fresh assembly. */
function parseStoredMorningBrief(content: unknown): StoredMorningBrief | null {
  const parsed = MorningBriefContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const extras = content as SlackDelivery;
  return {
    ...parsed.data,
    slackTs: typeof extras.slackTs === 'string' ? extras.slackTs : null,
    ...(extras.slackThreads === undefined ? {} : { slackThreads: extras.slackThreads }),
  };
}

export async function runAfternoonBoard(deps: BriefDeps): Promise<BriefResult> {
  const now = deps.now ?? nowIso;
  const correlationId = newUlid();
  const morning = await todaysMorningBrief(deps, now);
  const since = morning?.generatedAt ?? startOfLocalDay(new Date(now()), deps.config.timeZone);
  const board = AfternoonBoardContentSchema.parse(
    await assembleAfternoonBoard(dataDeps(deps, now), since),
  );
  const date = localDate(new Date(now()), deps.config.timeZone);

  let slackTs: string | null = null;
  if (deps.slack !== null) {
    const posted = await deps.slack.post(
      {
        text: renderAfternoonBoardSlack(
          board,
          deps.config.timeZone,
          deps.config.agentDisplayName,
          date,
        ),
      },
      { correlationId },
    );
    slackTs = posted.ts;
  }
  const briefId = await recordBrief(
    deps,
    'afternoon_board',
    correlationId,
    { ...board, slackTs },
    renderAfternoonBoardMarkdown(board, deps.config.timeZone, date),
    slackTs,
    now,
  );
  return { briefId, correlationId, slackTs };
}

/** One prep line per open commitment: who owes it, what it is, how late it is. */
function commitmentLine(
  commitment: MorningBriefContent['meetings'][number]['commitments'][number],
): string {
  const owes = commitment.direction === 'outbound' ? 'You owe' : 'Owed to you';
  const late =
    commitment.overdueDays === null || commitment.overdueDays <= 0
      ? ''
      : ` (${String(commitment.overdueDays)} ${commitment.overdueDays === 1 ? 'day' : 'days'} overdue)`;
  return `- ${owes}: ${commitment.description}${late}`;
}

/**
 * Meeting prep (spec 10.3): the meeting's section from the morning brief,
 * the last transcript with the same people, and open commitments. Posted
 * as a thread reply under the brief's entry for the meeting when one
 * exists, otherwise as its own message. One prep per event, checked in
 * `briefs`.
 */
export async function runMeetingPrep(deps: BriefDeps): Promise<BriefResult[]> {
  const now = deps.now ?? nowIso;
  const at = new Date(now());
  const horizon = new Date(at.getTime() + PREP_LEAD_MINUTES.external * 60 * 1000);
  const events = await calendarEvents(dataDeps(deps, now), at, addDays(at, 1));
  const morning = await todaysMorningBrief(deps, now);
  const morningContent = morning === null ? null : parseStoredMorningBrief(morning.content);
  const results: BriefResult[] = [];

  for (const event of events) {
    if (event.start > horizon) continue;
    const fromBrief = morningContent?.meetings.find((m) => m.id === event.id) ?? null;
    const lead =
      fromBrief?.audience === 'internal' ? PREP_LEAD_MINUTES.internal : PREP_LEAD_MINUTES.external;
    if (event.start.getTime() - at.getTime() > lead * 60 * 1000) continue;
    const existing = await deps.db
      .select({ id: briefs.id })
      .from(briefs)
      .where(
        and(eq(briefs.kind, 'meeting_prep'), sql`${briefs.content} ->> 'eventId' = ${event.id}`),
      )
      .limit(1);
    if (existing.length > 0) continue;

    const section =
      fromBrief ??
      (await assembleMorningBrief(dataDeps(deps, now))).content.meetings.find(
        (m) => m.id === event.id,
      ) ??
      null;
    if (section === null) continue;
    const transcript = section.documents[0] ?? null;
    const unknown = section.attendees.filter((a) => a.unknown).map((a) => a.name);
    const lines = [
      `*Prep: ${section.title}*`,
      `Attendees: ${section.attendees.map((a) => `${a.name}${a.organisation === null ? '' : `, ${a.organisation}`}`).join('; ') || 'none'}`,
      ...(section.objectives.length === 0 ? [] : [`Objectives: ${section.objectives.join(' ')}`]),
      ...(section.commitments.length === 0
        ? []
        : ['Open:', ...section.commitments.map(commitmentLine)]),
      ...(transcript === null
        ? []
        : [
            `Last transcript: ${transcript.url === null ? transcript.title : `<${transcript.url}|${transcript.title}>`}`,
          ]),
      ...(unknown.length === 0 ? [] : [`Unknown attendees: ${unknown.join(', ')}`]),
    ];
    const correlationId = newUlid();
    let slackTs: string | null = null;
    if (deps.slack !== null) {
      const threadTs =
        morningContent?.slackThreads?.[event.id] ?? morningContent?.slackTs ?? undefined;
      const posted = await deps.slack.post(
        {
          text: lines.join('\n'),
          ...(threadTs === undefined ? {} : { threadTs }),
        },
        { correlationId },
      );
      slackTs = posted.ts;
    }
    const briefId = await recordBrief(
      deps,
      'meeting_prep',
      correlationId,
      { eventId: event.id, section, slackTs },
      lines.join('\n').replace(/\*/g, ''),
      slackTs,
      now,
    );
    results.push({ briefId, correlationId, slackTs });
  }
  return results;
}

/** Schedules (spec 9.1): brief 06:30 and board 16:00 on weekdays, prep checks every five minutes in the working day. */
export async function registerBriefs(boss: PgBoss, deps: BriefDeps): Promise<void> {
  const tz = deps.config.timeZone;
  await boss.createQueue(QUEUE_MORNING);
  await boss.schedule(QUEUE_MORNING, '30 6 * * 1-5', {}, { tz, key: QUEUE_MORNING });
  await work(boss, QUEUE_MORNING, async () => {
    await runMorningBrief(deps);
  });
  await boss.createQueue(QUEUE_BOARD);
  await boss.schedule(QUEUE_BOARD, '0 16 * * 1-5', {}, { tz, key: QUEUE_BOARD });
  await work(boss, QUEUE_BOARD, async () => {
    await runAfternoonBoard(deps);
  });
  await boss.createQueue(QUEUE_PREP);
  await boss.schedule(QUEUE_PREP, '*/5 7-19 * * 1-5', {}, { tz, key: QUEUE_PREP });
  await work(boss, QUEUE_PREP, async () => {
    await runMeetingPrep(deps);
  });
}
