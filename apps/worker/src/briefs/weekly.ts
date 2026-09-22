import { runAgent, type AgentDeps } from '@lance/agents';
import type { SlackSurface } from '@lance/connectors';
import {
  agentRuns,
  alerts,
  briefs,
  commitments,
  observations,
  proposals,
  type Db,
} from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { BANNED_PHRASES, newUlid, nowIso, type Config } from '@lance/shared';
import { and, desc, gte, inArray, lt, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { work } from '../scheduler/boss.js';
import { z } from 'zod';
import { addDays, localDate, startOfLocalDay } from './local.js';

/**
 * The weekly review (spec 10.5), Friday 16:30: commitment ageing in both
 * directions, task completion by source, proposals by cell, promotion
 * candidates, cost by agent, alerts by kind, and three questions the
 * Planner wants answered to rank next week better. Everything but the
 * questions is deterministic SQL over the week.
 */

export const QUEUE_WEEKLY = 'brief-weekly-review';
export const WEEKLY_ACTOR = 'system:briefs';

export const WeeklyQuestionsSchema = z.object({
  questions: z.array(z.string().min(1).max(240)).length(3),
});

export interface WeeklyReview {
  weekEnding: string;
  since: string;
  commitmentAgeing: {
    direction: 'outbound' | 'inbound';
    open: number;
    overdue: number;
    oldestOpenDays: number | null;
  }[];
  taskCompletion: { source: string; completed: number; opened: number }[];
  proposalsByCell: {
    cell: string;
    approved: number;
    edited: number;
    rejected: number;
    auto: number;
    held: number;
  }[];
  promotionCandidates: { cell: string; approvals: number; rejects: number }[];
  costByAgent: { agent: string; runs: number; gbp: number }[];
  alertsByKind: { kind: string; count: number }[];
  questions: string[];
}

export interface WeeklyDeps {
  db: Db;
  config: Pick<Config, 'timeZone' | 'cost' | 'promotion' | 'models' | 'agentDisplayName'>;
  agent: AgentDeps | null;
  slack: Pick<SlackSurface, 'post'> | null;
  now?: () => string;
}

function cellOf(row: {
  actionClass: string;
  counterpartyClass: string;
  targetSystem: string;
}): string {
  return `${row.actionClass} / ${row.counterpartyClass} / ${row.targetSystem}`;
}

export async function assembleWeeklyReview(
  deps: WeeklyDeps,
): Promise<Omit<WeeklyReview, 'questions'>> {
  const now = new Date((deps.now ?? nowIso)());
  const zone = deps.config.timeZone;
  const since = addDays(startOfLocalDay(now, zone), -7);
  const nowMs = now.getTime();

  const openRows = await deps.db
    .select()
    .from(commitments)
    .where(inArray(commitments.status, ['open', 'chased']));
  const commitmentAgeing = (['outbound', 'inbound'] as const).map((direction) => {
    const mine = openRows.filter((row) => row.direction === direction);
    const overdue = mine.filter((row) => row.dueAt !== null && row.dueAt.getTime() < nowMs).length;
    const oldest = mine.reduce<number | null>((best, row) => {
      const days = Math.floor((nowMs - row.createdAt.getTime()) / 86_400_000);
      return best === null || days > best ? days : best;
    }, null);
    return { direction, open: mine.length, overdue, oldestOpenDays: oldest };
  });

  const taskRows = await deps.db
    .select({
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      payload: observations.payload,
      ts: observations.ts,
    })
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['notion', 'jamie']),
        gte(observations.ts, since),
        sql`${observations.payload} ->> 'kind' = 'task'`,
      ),
    )
    .orderBy(desc(observations.ts));
  const completion = new Map<string, { completed: Set<string>; opened: Set<string> }>();
  for (const row of taskRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const entry = completion.get(row.sourceSystem) ?? { completed: new Set(), opened: new Set() };
    const done =
      row.sourceSystem === 'jamie'
        ? p['completed'] === true
        : ['Done', 'Cancelled', 'Archived'].includes(
            typeof p['status'] === 'string' ? p['status'] : '',
          );
    (done ? entry.completed : entry.opened).add(row.sourceRecordId);
    completion.set(row.sourceSystem, entry);
  }
  const taskCompletion = [...completion.entries()].map(([source, sets]) => ({
    source,
    completed: sets.completed.size,
    opened: sets.opened.size,
  }));

  const proposalRows = await deps.db
    .select()
    .from(proposals)
    .where(gte(proposals.createdAt, since));
  const byCell = new Map<string, WeeklyReview['proposalsByCell'][number]>();
  for (const row of proposalRows) {
    const cell = cellOf(row);
    const entry = byCell.get(cell) ?? {
      cell,
      approved: 0,
      edited: 0,
      rejected: 0,
      auto: 0,
      held: 0,
    };
    if (row.decidedBy === 'system:policy' && row.policyDecision === 'auto') entry.auto += 1;
    else if (row.status === 'rejected') entry.rejected += 1;
    else if (row.status === 'edited') entry.edited += 1;
    else if (['approved', 'executing', 'executed'].includes(row.status)) entry.approved += 1;
    else if (row.status === 'held') entry.held += 1;
    byCell.set(cell, entry);
  }
  const proposalsByCell = [...byCell.values()].sort((a, b) => a.cell.localeCompare(b.cell));

  // Spec 6.4: a cell earns autonomy after `threshold` clean approvals with no reject.
  const windowStart = addDays(startOfLocalDay(now, zone), -deps.config.promotion.minSpanDays);
  const promotionRows = await deps.db
    .select()
    .from(proposals)
    .where(
      and(gte(proposals.decidedAt, windowStart), sql`${proposals.decidedBy} <> 'system:policy'`),
    );
  const tallies = new Map<string, { approvals: number; rejects: number }>();
  for (const row of promotionRows) {
    const cell = cellOf(row);
    const entry = tallies.get(cell) ?? { approvals: 0, rejects: 0 };
    if (row.status === 'rejected') entry.rejects += 1;
    else if (['approved', 'executing', 'executed'].includes(row.status)) entry.approvals += 1;
    tallies.set(cell, entry);
  }
  const promotionCandidates = [...tallies.entries()]
    .filter(([, t]) => t.approvals >= deps.config.promotion.threshold && t.rejects === 0)
    .map(([cell, t]) => ({ cell, ...t }));

  const costRows = await deps.db
    .select({
      agent: agentRuns.agent,
      runs: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(${agentRuns.estimatedCostUsd}), 0)::text`,
    })
    .from(agentRuns)
    .where(and(gte(agentRuns.startedAt, since), lt(agentRuns.startedAt, now)))
    .groupBy(agentRuns.agent);
  const costByAgent = costRows
    .map((row) => ({
      agent: row.agent,
      runs: row.runs,
      gbp: Math.round(Number(row.usd) * deps.config.cost.usdToGbp * 100) / 100,
    }))
    .sort((a, b) => b.gbp - a.gbp);

  const alertRows = await deps.db
    .select({ kind: alerts.kind, count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(gte(alerts.lastSeen, since))
    .groupBy(alerts.kind);
  const alertsByKind = alertRows
    .map((row) => ({ kind: row.kind, count: row.count }))
    .sort((a, b) => b.count - a.count);

  return {
    weekEnding: localDate(now, zone),
    since: since.toISOString(),
    commitmentAgeing,
    taskCompletion,
    proposalsByCell,
    promotionCandidates,
    costByAgent,
    alertsByKind,
  };
}

export function renderWeeklyReview(review: WeeklyReview, displayName: string): string {
  const ageing = review.commitmentAgeing
    .map(
      (a) =>
        `${a.direction === 'outbound' ? 'You owe' : 'Owed to you'}: ${String(a.open)} open, ${String(a.overdue)} overdue, oldest ${a.oldestOpenDays === null ? 'none' : `${String(a.oldestOpenDays)} days`}`,
    )
    .join('\n');
  const tasks =
    review.taskCompletion
      .map((t) => `${t.source}: ${String(t.completed)} completed, ${String(t.opened)} still open`)
      .join('; ') || 'none';
  const cells = review.proposalsByCell
    .map(
      (c) =>
        `${c.cell}: ${String(c.approved)} approved, ${String(c.edited)} edited, ${String(c.rejected)} rejected, ${String(c.auto)} auto, ${String(c.held)} held`,
    )
    .join('\n');
  const promotion =
    review.promotionCandidates
      .map((p) => `${p.cell} (${String(p.approvals)} approvals)`)
      .join('; ') || 'none';
  const cost =
    review.costByAgent
      .map((c) => `${c.agent} GBP ${c.gbp.toFixed(2)} over ${String(c.runs)} runs`)
      .join('; ') || 'none';
  const alertsLine =
    review.alertsByKind.map((a) => `${a.kind} ${String(a.count)}`).join('; ') || 'none';
  return [
    `*${displayName} weekly review, week ending ${review.weekEnding}*`,
    '*Commitments*',
    ageing,
    `*Tasks* ${tasks}`,
    '*Proposals by cell*',
    cells || 'none',
    `*Promotion candidates* ${promotion}`,
    `*Cost by agent* ${cost}`,
    `*Alerts by kind* ${alertsLine}`,
  ].join('\n');
}

export function renderWeeklyReviewMarkdown(review: WeeklyReview): string {
  return [
    `# Weekly review, week ending ${review.weekEnding}`,
    '',
    '## Commitments',
    ...review.commitmentAgeing.map(
      (a) =>
        `- ${a.direction}: ${String(a.open)} open, ${String(a.overdue)} overdue, oldest ${a.oldestOpenDays === null ? 'none' : `${String(a.oldestOpenDays)} days`}`,
    ),
    '',
    '## Tasks',
    ...review.taskCompletion.map(
      (t) => `- ${t.source}: ${String(t.completed)} completed, ${String(t.opened)} open`,
    ),
    review.taskCompletion.length === 0 ? 'None.' : '',
    '## Proposals by cell',
    ...review.proposalsByCell.map(
      (c) =>
        `- ${c.cell}: ${String(c.approved)} approved, ${String(c.edited)} edited, ${String(c.rejected)} rejected, ${String(c.auto)} auto, ${String(c.held)} held`,
    ),
    review.proposalsByCell.length === 0 ? 'None.' : '',
    '## Promotion candidates',
    ...review.promotionCandidates.map((p) => `- ${p.cell}: ${String(p.approvals)} approvals`),
    review.promotionCandidates.length === 0 ? 'None.' : '',
    '## Cost by agent',
    ...review.costByAgent.map(
      (c) => `- ${c.agent}: GBP ${c.gbp.toFixed(2)} over ${String(c.runs)} runs`,
    ),
    '',
    '## Alerts by kind',
    ...review.alertsByKind.map((a) => `- ${a.kind}: ${String(a.count)}`),
    '',
    '## Questions for next week',
    ...review.questions.map((q, i) => `${String(i + 1)}. ${q}`),
  ].join('\n');
}

function questionsSystemPrompt(displayName: string): string {
  return [
    `You are ${displayName}'s planner. Each Friday you read the week's numbers for Dom Selvon, a director at Valliance, and ask him exactly three questions whose answers would improve how you rank his tasks and meetings next week.`,
    'Each question is one sentence, specific to something in the numbers (a cell with many rejects, a source with nothing completed, an agent costing more than its value, an overdue commitment), and answerable in a line. British English, no em dashes, none of these phrases: ' +
      BANNED_PHRASES.join(', ') +
      '. Reply with only the JSON object.',
  ].join('\n');
}

/** Runs the review: aggregates, three Planner questions, brief row, Slack post with the questions in thread. */
export async function runWeeklyReview(
  deps: WeeklyDeps,
): Promise<{ briefId: string; slackTs: string | null }> {
  const now = deps.now ?? nowIso;
  const correlationId = newUlid();
  const facts = await assembleWeeklyReview(deps);

  let questions: string[] = [];
  if (deps.agent !== null) {
    const result = await runAgent(
      deps.agent,
      {
        name: 'planner-weekly',
        version: '0.1.0',
        model: deps.config.models.planner,
        system: questionsSystemPrompt(deps.config.agentDisplayName),
        tools: [],
        outputSchema: WeeklyQuestionsSchema,
        maxIterations: 1,
      },
      {
        correlationId,
        prompt: renderWeeklyReview(
          { ...facts, questions: [] },
          deps.config.agentDisplayName,
        ).replace(/\*/g, ''),
      },
    );
    questions = result.output.questions;
  }
  const review: WeeklyReview = { ...facts, questions };

  let slackTs: string | null = null;
  if (deps.slack !== null) {
    const parent = await deps.slack.post(
      { text: renderWeeklyReview(review, deps.config.agentDisplayName) },
      { correlationId },
    );
    slackTs = parent.ts;
    if (questions.length > 0) {
      await deps.slack.post(
        {
          text: `Three questions for next week:\n${questions.map((q, i) => `${String(i + 1)}. ${q}`).join('\n')}`,
          threadTs: parent.ts,
        },
        { correlationId },
      );
    }
  }

  const briefId = newUlid();
  await deps.db.insert(briefs).values({
    id: briefId,
    kind: 'weekly_review',
    correlationId,
    content: { ...review, slackTs },
    markdown: renderWeeklyReviewMarkdown(review),
    generatedAt: new Date(now()),
  });
  await new LedgerWriter(deps.db).append({
    ts: now(),
    actor: WEEKLY_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId,
    payload: { kind: 'brief', briefKind: 'weekly_review', briefId, slackTs },
  });
  return { briefId, slackTs };
}

export async function registerWeeklyReview(boss: PgBoss, deps: WeeklyDeps): Promise<void> {
  await boss.createQueue(QUEUE_WEEKLY);
  await boss.schedule(
    QUEUE_WEEKLY,
    '30 16 * * 5',
    {},
    { tz: deps.config.timeZone, key: QUEUE_WEEKLY },
  );
  await work(boss, QUEUE_WEEKLY, async () => {
    await runWeeklyReview(deps);
  });
}
